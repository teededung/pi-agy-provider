/**
 * `/swarm board` UI — interactive full-screen overlay dashboard for native
 * Antigravity swarms, matching native `/swarm board` ergonomics:
 *   - Roster pane (members, status, model, unread count, live activity)
 *   - Posts feed (#seq, sender, preview, `p` member filter, `f` follow mode)
 *   - Message detail pane (Markdown-rendered post body, `[`/`]` step posts)
 *   - `tab`/`shift+tab` switch pane, `z` zoom pane, `o` open member transcript,
 *     `r` rescan, `esc`/`q` back out / close.
 */

import {
  getMarkdownTheme,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { readAgySubagentProgressLog, type AgySubagentStatus } from "../lib/subagents.ts";
import type { AgySwarmMember, AgySwarmPost, AgySwarmSnapshot } from "../lib/swarm.ts";

export type SwarmBoardPane = "roster" | "posts" | "message";

const PANES: readonly SwarmBoardPane[] = ["roster", "posts", "message"];
const LIVE_REFRESH_MS = 1_000;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function padRight(text: string, targetWidth: number): string {
  const truncated = truncateToWidth(text, targetWidth, "…");
  const w = visibleWidth(truncated);
  return w < targetWidth ? truncated + " ".repeat(targetWidth - w) : truncated;
}

function memberStatusGlyph(member: AgySwarmMember, theme: Theme): string {
  if (member.failure) return theme.fg("error", "▲");
  switch (member.status) {
    case "working":
      return theme.fg("warning", "🐝");
    case "waiting":
      return theme.fg("success", "○");
    case "stopped":
      return theme.fg("dim", "◌");
    case "killed":
      return theme.fg("muted", "✕");
  }
}

function toSubagentStatus(status: AgySwarmMember["status"]): AgySubagentStatus {
  switch (status) {
    case "working":
      return "running";
    case "killed":
      return "killed";
    default:
      return "done";
  }
}

function formatPostTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T"));
  if (!Number.isFinite(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function filterSwarmPosts(
  posts: ReadonlyArray<AgySwarmPost>,
  memberFilter?: string,
): AgySwarmPost[] {
  if (!memberFilter) return [...posts];
  const lower = memberFilter.toLowerCase();
  return posts.filter(
    (p) =>
      p.agent.toLowerCase() === lower ||
      p.all ||
      p.mentions.some((m) => m.toLowerCase() === lower),
  );
}

interface MemberTranscriptDetail {
  memberName: string;
  lines: string[];
  scroll: number;
}

export class AgySwarmBoardDashboard implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private rescanFn: () => Promise<AgySwarmSnapshot | undefined>;
  private done: (value: null) => void;

  private snapshot: AgySwarmSnapshot;
  private focusPane: SwarmBoardPane = "posts";
  private zoomed = false;
  private follow = true;
  private memberFilter: string | undefined;

  private selectedMemberName: string | undefined;
  private memberIndex = 0;
  private selectedPostSeq: number | undefined;
  private postIndex = 0;
  private messageScroll = 0;

  private memberDetail: MemberTranscriptDetail | null = null;
  private closed = false;
  private liveRefreshInFlight = false;
  private liveRefreshTimer: ReturnType<typeof setInterval>;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    initialSnapshot: AgySwarmSnapshot,
    rescanFn: () => Promise<AgySwarmSnapshot | undefined>,
    done: (value: null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.snapshot = initialSnapshot;
    this.rescanFn = rescanFn;
    this.done = done;

    this.reconcileSelection();
    this.liveRefreshTimer = setInterval(() => void this.refreshLiveData(), LIVE_REFRESH_MS);
    this.liveRefreshTimer.unref?.();
  }

  private reconcileSelection(): void {
    const members = this.snapshot.members;
    if (members.length === 0) {
      this.memberIndex = 0;
      this.selectedMemberName = undefined;
    } else {
      const idx = this.selectedMemberName
        ? members.findIndex((m) => m.name === this.selectedMemberName)
        : -1;
      this.memberIndex = idx >= 0 ? idx : Math.min(Math.max(0, this.memberIndex), members.length - 1);
      this.selectedMemberName = members[this.memberIndex]?.name;
    }

    const visiblePosts = this.visiblePosts();
    if (visiblePosts.length === 0) {
      this.postIndex = 0;
      this.selectedPostSeq = undefined;
      this.messageScroll = 0;
      return;
    }
    if (this.follow) {
      this.postIndex = visiblePosts.length - 1;
      this.selectedPostSeq = visiblePosts[this.postIndex]?.seq;
      this.messageScroll = 0;
      return;
    }
    const idx =
      this.selectedPostSeq !== undefined
        ? visiblePosts.findIndex((p) => p.seq === this.selectedPostSeq)
        : -1;
    this.postIndex =
      idx >= 0 ? idx : Math.min(Math.max(0, this.postIndex), visiblePosts.length - 1);
    this.selectedPostSeq = visiblePosts[this.postIndex]?.seq;
  }

  private visiblePosts(): AgySwarmPost[] {
    return filterSwarmPosts(this.snapshot.posts, this.memberFilter);
  }

  private stopLiveRefresh(): void {
    clearInterval(this.liveRefreshTimer);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopLiveRefresh();
    this.done(null);
  }

  dispose(): void {
    this.closed = true;
    this.stopLiveRefresh();
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  private async refreshLiveData(): Promise<void> {
    if (this.closed || this.liveRefreshInFlight) return;
    this.liveRefreshInFlight = true;
    try {
      const next = await this.rescanFn().catch(() => undefined);
      if (this.closed || !next) return;
      this.snapshot = next;
      this.reconcileSelection();

      if (this.memberDetail) {
        const target = this.snapshot.members.find((m) => m.name === this.memberDetail?.memberName);
        if (target?.conversationId) {
          const cols = Math.max(24, (this.tui.terminal.columns || 100) - 4);
          const lines = await readAgySubagentProgressLog(
            {
              conversationId: target.conversationId,
              name: target.name,
              status: toSubagentStatus(target.status),
              error: target.failure?.text,
            },
            { theme: this.theme, width: cols },
          );
          if (!this.closed && this.memberDetail) {
            this.memberDetail.lines = lines;
          }
        }
      }
      this.tui.requestRender();
    } finally {
      this.liveRefreshInFlight = false;
    }
  }

  private async openSelectedMemberDetail(): Promise<void> {
    const member = this.snapshot.members[this.memberIndex];
    if (!member?.conversationId) return;
    const cols = Math.max(24, (this.tui.terminal.columns || 100) - 4);
    const lines = await readAgySubagentProgressLog(
      {
        conversationId: member.conversationId,
        name: member.name,
        status: toSubagentStatus(member.status),
        error: member.failure?.text,
      },
      { theme: this.theme, width: cols },
    );
    if (this.closed) return;
    this.memberDetail = {
      memberName: member.name,
      lines,
      scroll: Math.max(0, lines.length - 12),
    };
    this.tui.requestRender();
  }

  private stepPost(delta: -1 | 1): void {
    const posts = this.visiblePosts();
    if (posts.length === 0) return;
    this.follow = false;
    this.postIndex = Math.min(Math.max(0, this.postIndex + delta), posts.length - 1);
    this.selectedPostSeq = posts[this.postIndex]?.seq;
    this.messageScroll = 0;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.memberDetail) {
      this.handleDetailInput(data);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel") || data === "q") {
      if (this.zoomed) {
        this.zoomed = false;
        this.tui.requestRender();
        return;
      }
      this.close();
      return;
    }

    // Tab / Shift+Tab cycle panes.
    if (data === "\t" || this.keybindings.matches(data, "tui.input.tab")) {
      const idx = PANES.indexOf(this.focusPane);
      this.focusPane = PANES[(idx + 1) % PANES.length]!;
      this.tui.requestRender();
      return;
    }
    if (data === "\x1b[Z") {
      const idx = PANES.indexOf(this.focusPane);
      this.focusPane = PANES[(idx - 1 + PANES.length) % PANES.length]!;
      this.tui.requestRender();
      return;
    }

    if (data === "z") {
      this.zoomed = !this.zoomed;
      this.tui.requestRender();
      return;
    }
    if (data === "[") {
      this.stepPost(-1);
      return;
    }
    if (data === "]") {
      this.stepPost(1);
      return;
    }
    if (data === "f") {
      this.follow = !this.follow;
      this.reconcileSelection();
      this.tui.requestRender();
      return;
    }
    if (data === "p") {
      const target = this.snapshot.members[this.memberIndex]?.name;
      if (this.memberFilter) {
        this.memberFilter = undefined;
      } else if (target) {
        this.memberFilter = target;
      }
      this.reconcileSelection();
      this.tui.requestRender();
      return;
    }
    if (data === "o") {
      void this.openSelectedMemberDetail();
      return;
    }
    if (data === "r") {
      void this.refreshLiveData();
      return;
    }

    const up = this.keybindings.matches(data, "tui.select.up") || data === "k";
    const down = this.keybindings.matches(data, "tui.select.down") || data === "j";

    if (this.focusPane === "roster") {
      if ((up || down) && this.snapshot.members.length > 0) {
        const len = this.snapshot.members.length;
        this.memberIndex = up ? (this.memberIndex - 1 + len) % len : (this.memberIndex + 1) % len;
        this.selectedMemberName = this.snapshot.members[this.memberIndex]?.name;
        this.tui.requestRender();
        return;
      }
      if (this.keybindings.matches(data, "tui.select.confirm")) {
        void this.openSelectedMemberDetail();
        return;
      }
    } else if (this.focusPane === "posts") {
      if (up) {
        this.stepPost(-1);
        return;
      }
      if (down) {
        this.stepPost(1);
        return;
      }
      if (this.keybindings.matches(data, "tui.select.confirm")) {
        this.focusPane = "message";
        this.tui.requestRender();
        return;
      }
    } else {
      if (up) {
        this.messageScroll = Math.max(0, this.messageScroll - 1);
        this.tui.requestRender();
        return;
      }
      if (down) {
        this.messageScroll += 1;
        this.tui.requestRender();
        return;
      }
      if (this.keybindings.matches(data, "tui.select.pageUp")) {
        this.messageScroll = Math.max(0, this.messageScroll - 10);
        this.tui.requestRender();
        return;
      }
      if (this.keybindings.matches(data, "tui.select.pageDown")) {
        this.messageScroll += 10;
        this.tui.requestRender();
        return;
      }
      if (this.keybindings.matches(data, "tui.select.confirm")) {
        this.focusPane = "posts";
        this.tui.requestRender();
        return;
      }
    }
  }

  private handleDetailInput(data: string): void {
    const detail = this.memberDetail;
    if (!detail) return;
    if (this.keybindings.matches(data, "tui.select.cancel") || data === "q") {
      this.memberDetail = null;
      this.tui.requestRender();
      return;
    }
    const viewport = Math.max(6, (this.tui.terminal.rows || 30) - 8);
    const maxScroll = Math.max(0, detail.lines.length - viewport);
    const scrollTo = (v: number) => {
      detail.scroll = Math.min(Math.max(0, v), maxScroll);
      this.tui.requestRender();
    };
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      scrollTo(detail.scroll - 1);
    } else if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      scrollTo(detail.scroll + 1);
    } else if (this.keybindings.matches(data, "tui.select.pageUp")) {
      scrollTo(detail.scroll - viewport);
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      scrollTo(detail.scroll + viewport);
    } else if (data === "g") {
      scrollTo(0);
    } else if (data === "G") {
      scrollTo(maxScroll);
    } else if (data === "r") {
      void this.refreshLiveData();
    }
  }

  private renderMemberDetail(width: number, totalHeight: number): string[] {
    const t = this.theme;
    const detail = this.memberDetail!;
    const innerWidth = Math.max(20, width - 2);
    const wrapped: string[] = [];
    for (const line of detail.lines) {
      if (!line) {
        wrapped.push("");
        continue;
      }
      if (visibleWidth(line) <= innerWidth) wrapped.push(line);
      else wrapped.push(...wrapTextWithAnsi(line, innerWidth));
    }
    const bodyHeight = Math.max(6, totalHeight - 4);
    const maxScroll = Math.max(0, wrapped.length - bodyHeight);
    detail.scroll = Math.min(detail.scroll, maxScroll);
    const visible = wrapped.slice(detail.scroll, detail.scroll + bodyHeight);
    while (visible.length < bodyHeight) visible.push("");

    const member = this.snapshot.members.find((m) => m.name === detail.memberName);
    const header =
      t.fg("accent", t.bold(`🐝 ${detail.memberName}`)) +
      (member?.model ? t.fg("dim", ` · ${member.model}`) : "") +
      (member ? t.fg("muted", ` · ${member.status}`) : "");
    const footer = t.fg("dim", "↑/↓ scroll · g/G top/end · r refresh · esc back to board");
    return [
      truncateToWidth(header, width, "…"),
      t.fg("borderMuted", "─".repeat(width)),
      ...visible.map((l) => `  ${truncateToWidth(l, innerWidth, "…")}`),
      t.fg("borderMuted", "─".repeat(width)),
      truncateToWidth(footer, width, "…"),
    ];
  }

  private renderPaneBox(
    title: string,
    focused: boolean,
    bodyLines: string[],
    width: number,
    height: number,
  ): string[] {
    const t = this.theme;
    const inner = Math.max(8, width - 2);
    const borderColor = focused ? "accent" : "borderMuted";
    const titleLabel = focused ? t.fg("accent", t.bold(` ${title} `)) : t.fg("muted", ` ${title} `);
    const titleW = visibleWidth(titleLabel);
    const fill = Math.max(0, width - 3 - titleW);
    const top =
      t.fg(borderColor, "┌─") + titleLabel + t.fg(borderColor, `${"─".repeat(fill)}┐`);

    const contentHeight = Math.max(1, height - 2);
    const rows: string[] = [top];
    for (let i = 0; i < contentHeight; i += 1) {
      const line = bodyLines[i] ?? "";
      rows.push(t.fg(borderColor, "│") + padRight(line, inner) + t.fg(borderColor, "│"));
    }
    rows.push(t.fg(borderColor, `└${"─".repeat(Math.max(0, width - 2))}┘`));
    return rows;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(40, width);
    const totalRows = Math.max(18, (this.tui.terminal.rows || 32) - 4);
    if (this.memberDetail) {
      return this.renderMemberDetail(safeWidth, totalRows);
    }

    const t = this.theme;
    const snap = this.snapshot;
    const statusText = snap.done
      ? t.fg("success", "● Done")
      : snap.workingCount > 0
        ? t.fg("warning", `● ${snap.workingCount} working`)
        : t.fg("dim", "○ waiting");
    const flags = [
      this.follow ? t.fg("accent", "follow") : undefined,
      this.memberFilter ? t.fg("warning", `filter:@${this.memberFilter}`) : undefined,
      this.zoomed ? t.fg("accent", `zoom:${this.focusPane}`) : undefined,
    ]
      .filter(Boolean)
      .join(t.fg("dim", " · "));

    const headerLeft =
      t.fg("accent", t.bold(`🐝 Swarm(${snap.title})`)) +
      t.fg("dim", ` · ${snap.members.length} members · ${snap.posts.length} posts · `) +
      statusText +
      (flags ? t.fg("dim", " · ") + flags : "");
    const headerLines = [truncateToWidth(headerLeft, safeWidth, "…")];
    if (snap.headline) {
      headerLines.push(truncateToWidth(t.fg("muted", snap.headline), safeWidth, "…"));
    }

    const footerHelp = truncateToWidth(
      t.fg(
        "dim",
        "tab pane · ↑/↓ move · [/] post · z zoom · p filter · f follow · o member log · r refresh · esc close",
      ),
      safeWidth,
      "…",
    );

    const bodyHeight = Math.max(10, totalRows - headerLines.length - 1);

    const buildRosterLines = (innerW: number, maxRows: number): string[] => {
      if (snap.members.length === 0) return [t.fg("dim", "(no members yet)")];
      const start = Math.max(
        0,
        Math.min(this.memberIndex - Math.floor(maxRows / 2), snap.members.length - maxRows),
      );
      return snap.members.slice(start, start + maxRows).map((m, i) => {
        const selected = start + i === this.memberIndex;
        const prefix = selected ? t.fg("accent", "› ") : "  ";
        const glyph = memberStatusGlyph(m, t);
        const unread = m.unread > 0 ? t.fg("warning", ` (${m.unread})`) : "";
        const activity = m.failure
          ? t.fg("error", ` ! ${m.failure.kind}`)
          : m.activity
            ? t.fg("dim", ` · ${oneLine(m.activity)}`)
            : m.model
              ? t.fg("dim", ` · ${m.model}`)
              : "";
        return truncateToWidth(
          `${prefix}${glyph} ${selected ? t.bold(m.name) : m.name}${unread}${activity}`,
          innerW,
          "…",
        );
      });
    };

    const visiblePosts = this.visiblePosts();
    const buildPostLines = (innerW: number, maxRows: number): string[] => {
      if (visiblePosts.length === 0) {
        return [
          t.fg(
            "dim",
            this.memberFilter ? `(no posts matching @${this.memberFilter})` : "(no board posts yet)",
          ),
        ];
      }
      const start = Math.max(
        0,
        Math.min(this.postIndex - Math.floor(maxRows / 2), visiblePosts.length - maxRows),
      );
      return visiblePosts.slice(start, start + maxRows).map((p, i) => {
        const selected = start + i === this.postIndex;
        const prefix = selected ? t.fg("accent", "› ") : "  ";
        const ts = formatPostTime(p.time);
        const chan = p.channel ? t.fg("muted", ` [${p.channel}]`) : "";
        const head = `${prefix}${t.fg("dim", `#${p.seq}`)} ${
          selected ? t.fg("accent", t.bold(`@${p.agent}`)) : t.fg("text", `@${p.agent}`)
        }${chan}${ts ? t.fg("dim", ` ${ts}`) : ""}: `;
        const remain = Math.max(8, innerW - visibleWidth(head));
        return head + truncateToWidth(oneLine(p.text), remain, "…");
      });
    };

    const selectedPost = visiblePosts[this.postIndex];
    const buildMessageLines = (innerW: number, maxRows: number): string[] => {
      if (!selectedPost) return [t.fg("dim", "(select a post to read)")];
      const md = new Markdown(selectedPost.text.trim() || "(empty)", 1, 0, getMarkdownTheme());
      const rendered = md.render(Math.max(16, innerW));
      const maxScroll = Math.max(0, rendered.length - maxRows);
      this.messageScroll = Math.min(this.messageScroll, maxScroll);
      return rendered.slice(this.messageScroll, this.messageScroll + maxRows);
    };

    if (this.zoomed) {
      const innerW = Math.max(16, safeWidth - 2);
      const innerH = Math.max(4, bodyHeight - 2);
      const lines =
        this.focusPane === "roster"
          ? buildRosterLines(innerW, innerH)
          : this.focusPane === "posts"
            ? buildPostLines(innerW, innerH)
            : buildMessageLines(innerW, innerH);
      const title =
        this.focusPane === "roster"
          ? `Roster (${snap.members.length})`
          : this.focusPane === "posts"
            ? `Posts (${visiblePosts.length})`
            : selectedPost
              ? `Message #${selectedPost.seq} @${selectedPost.agent}`
              : "Message";
      return [
        ...headerLines,
        ...this.renderPaneBox(title, true, lines, safeWidth, bodyHeight),
        footerHelp,
      ];
    }

    const topHeight = Math.max(6, Math.floor(bodyHeight * 0.45));
    const bottomHeight = Math.max(4, bodyHeight - topHeight);
    const leftWidth = Math.max(26, Math.min(44, Math.floor(safeWidth * 0.36)));
    const rightWidth = Math.max(24, safeWidth - leftWidth);

    const rosterBox = this.renderPaneBox(
      `Roster (${snap.members.length})`,
      this.focusPane === "roster",
      buildRosterLines(leftWidth - 2, topHeight - 2),
      leftWidth,
      topHeight,
    );
    const postsBox = this.renderPaneBox(
      `Posts (${visiblePosts.length})`,
      this.focusPane === "posts",
      buildPostLines(rightWidth - 2, topHeight - 2),
      rightWidth,
      topHeight,
    );
    const topCombined = rosterBox.map((line, i) => `${line}${postsBox[i] ?? ""}`);

    const messageTitle = selectedPost
      ? `Message #${selectedPost.seq} · @${selectedPost.agent}${
          selectedPost.channel ? ` [${selectedPost.channel}]` : ""
        }`
      : "Message";
    const messageBox = this.renderPaneBox(
      messageTitle,
      this.focusPane === "message",
      buildMessageLines(safeWidth - 2, bottomHeight - 2),
      safeWidth,
      bottomHeight,
    );

    return [...headerLines, ...topCombined, ...messageBox, footerHelp];
  }
}

export async function openAgySwarmBoard(
  ctx: ExtensionCommandContext,
  initialSnapshot: AgySwarmSnapshot,
  rescan: () => Promise<AgySwarmSnapshot | undefined>,
): Promise<void> {
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      new AgySwarmBoardDashboard(tui, theme, keybindings, initialSnapshot, rescan, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}
