/**
 * Native Antigravity `/swarm` state reader & liveness probe.
 *
 * Reads the swarm directory maintained by `agy` under
 * `~/.gemini/antigravity-cli/brain/<coordinatorConv>/.system_generated/swarm/`:
 *   - `members.json` (roster, coordinator, models, wake modes, cursors)
 *   - `board.jsonl`  (append-only `#seq` message feed)
 *   - `view.json`    (optional narrator Overview headline/phase)
 *   - `<brain>/<memberConv>/.system_generated/logs/transcript.jsonl`
 */

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { agyBrainDir } from "./tasks.ts";

export type AgySwarmMemberStatus = "working" | "waiting" | "stopped" | "killed";

export interface AgySwarmMember {
  name: string;
  conversationId?: string;
  model?: string;
  role?: string;
  wakeMode?: string;
  waitSince?: number;
  lastReadSeq?: number;
  killed: boolean;
  status: AgySwarmMemberStatus;
  activity?: string;
  activityKind?: "tool" | "thinking";
  steps?: number;
  failure?: { kind: "quota" | "error"; text: string };
  unread: number;
  postCount: number;
  lastPostSeq?: number;
  transcriptMtime?: number;
}

export interface AgySwarmPost {
  seq: number;
  agent: string;
  text: string;
  time: string;
  ts?: number;
  channel?: string;
  control?: string;
  mentions: string[];
  all: boolean;
}

export interface AgySwarmSnapshot {
  swarmId: string;
  coordinatorConversationId: string;
  dir: string;
  title: string;
  currentMember?: string;
  members: AgySwarmMember[];
  posts: AgySwarmPost[];
  headSeq: number;
  latestPost?: AgySwarmPost;
  workingCount: number;
  waitingCount: number;
  stoppedCount: number;
  killedCount: number;
  failedCount: number;
  done: boolean;
  headline?: string;
  phase?: { label?: string; index?: number; total?: number };
  newestUpdateMs: number;
}

export interface AgySwarmProbeResult {
  hasAlive: boolean;
  aliveCount: number;
  newestUpdateMs: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_WORKER_NAME_RE = /^(?:narrator|monitor)(?:-\d+)?$/i;
const QUOTA_RE = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit/i;
const STEP_ERROR_SETTLE_MS = 60_000;
const VIEW_MAX_BYTES = 64 * 1024;

function oneLine(text: string, maxLen = 96): string {
  const cleaned = text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1).trimEnd()}…` : cleaned;
}

function unquoteArg(v: unknown): string {
  if (typeof v !== "string") return v == null ? "" : String(v);
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

function describeToolCall(tc: { name?: unknown; args?: unknown } | undefined): string {
  const name = typeof tc?.name === "string" ? tc.name : "";
  if (!name) return "";
  if (name === "swarm_wait") return "Waiting for posts";
  if (name === "read_board") return "Reading the board";
  if (name === "post_message") return "Posting to the board";
  const args = tc?.args && typeof tc.args === "object" ? (tc.args as Record<string, unknown>) : {};
  const summary = unquoteArg(args.toolSummary) || unquoteArg(args.toolAction);
  if (summary) return oneLine(summary);
  const filePath = unquoteArg(args.Path || args.AbsolutePath || args.TargetFile || args.path);
  if (filePath) {
    const verb =
      name === "read_file" || name === "view_file"
        ? "Read"
        : name === "write_file" || name === "write_to_file"
          ? "Write"
          : name === "edit_file" || name === "replace_file_content"
            ? "Edit"
            : undefined;
    if (verb) return `${verb} ${path.basename(filePath)}`;
  }
  if (name === "swarm" && args.action) {
    return oneLine(`swarm ${unquoteArg(args.action)} ${unquoteArg(args.name)}`.trim());
  }
  return name;
}

function thinkingHeading(thinking: unknown): string {
  if (typeof thinking !== "string") return "";
  const hs = [...thinking.matchAll(/(?:^|\n)\s*\*\*([^*\n]{3,96})\*\*\s*(?=\n|$)/g)];
  return hs.length ? oneLine(hs[hs.length - 1]![1] ?? "") : "";
}

interface ParsedTranscriptSummary {
  steps: number;
  activity?: string;
  activityKind?: "tool" | "thinking";
  idle: boolean;
  replied: boolean;
  lastStep?: { type: string; status: string; error: string };
  mtimeMs: number;
}

function parseTranscriptSteps(raw: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Tolerate torn trailing line while agy appends.
    }
  }
  return out;
}

function turnHasEnded(steps: ReadonlyArray<Record<string, unknown>>): boolean {
  const results: Array<Record<string, unknown>> = [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]!;
    if (step.type === "GENERIC") {
      results.unshift(step);
      continue;
    }
    if (step.type !== "PLANNER_RESPONSE") return false;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    if (calls.length === 0) return results.length === 0;
    const waitIdx = calls.findIndex((c) => (c as { name?: unknown })?.name === "swarm_wait");
    return waitIdx >= 0 && results.length >= calls.length && results[waitIdx]?.status === "DONE";
  }
  return false;
}

function endedWithFinalReply(steps: ReadonlyArray<Record<string, unknown>>): boolean {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]!;
    if (step.type === "SYSTEM_MESSAGE") continue;
    if (step.type !== "PLANNER_RESPONSE") return false;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    return calls.length === 0;
  }
  return false;
}

async function readMemberTranscript(
  brainDir: string,
  conversationId: string | undefined,
): Promise<ParsedTranscriptSummary | undefined> {
  if (!conversationId || !UUID_RE.test(conversationId)) return undefined;
  const transcriptPath = path.join(
    brainDir,
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
  try {
    const [stat, content] = await Promise.all([
      fs.stat(transcriptPath),
      fs.readFile(transcriptPath, "utf-8"),
    ]);
    const steps = parseTranscriptSteps(content);
    let stepCount = steps.length;
    if (steps.length > 0) {
      const lastIdx = steps[steps.length - 1]?.step_index;
      if (typeof lastIdx === "number" && Number.isFinite(lastIdx)) {
        stepCount = Math.max(stepCount, lastIdx + 1);
      }
    }
    let lastStep: { type: string; status: string; error: string } | undefined;
    let activity: string | undefined;
    let activityKind: "tool" | "thinking" | undefined;

    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const step = steps[i]!;
      if (!lastStep) {
        lastStep = {
          type: String(step.type ?? ""),
          status: String(step.status ?? ""),
          error: typeof step.error === "string" ? oneLine(step.error, 240) : "",
        };
      }
      if (step.type === "USER_INPUT") break;
      if (step.type !== "PLANNER_RESPONSE") continue;
      const calls = Array.isArray(step.tool_calls)
        ? (step.tool_calls as Array<{ name?: unknown; args?: unknown }>)
        : [];
      if (calls.some((tc) => tc?.name === "swarm_wait")) break;
      const labeled = calls.map((tc) => describeToolCall(tc)).filter(Boolean);
      const latestTool = labeled[labeled.length - 1];
      const heading = thinkingHeading(step.thinking);
      if (latestTool) {
        activity = latestTool;
        activityKind = "tool";
        break;
      }
      if (heading) {
        activity = heading;
        activityKind = "thinking";
        break;
      }
    }

    return {
      steps: stepCount,
      activity,
      activityKind,
      idle: turnHasEnded(steps),
      replied: endedWithFinalReply(steps),
      lastStep,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return undefined;
  }
}

export function extractSwarmMentions(
  text: string,
  memberNames: ReadonlyArray<string>,
): { mentions: string[]; all: boolean } {
  const byLower = new Map(memberNames.map((n) => [n.toLowerCase(), n]));
  const mentions = new Set<string>();
  let all = false;
  const re = /(^|[^A-Za-z0-9_-])@([A-Za-z0-9_-]+)/g;
  for (const m of text.matchAll(re)) {
    const token = (m[2] ?? "").toLowerCase();
    if (!token) continue;
    if (token === "all") {
      all = true;
      continue;
    }
    const matched = byLower.get(token);
    if (matched) mentions.add(matched);
  }
  return { mentions: [...mentions], all };
}

function isDoneBoardPost(text: string): boolean {
  return /^\[done\](?=\s|$|[:.,!])/i.test(text.trim());
}

async function readRosterJson(
  rosterPath: string,
): Promise<{ title?: string; members?: Record<string, Record<string, unknown>> } | undefined> {
  try {
    const raw = await fs.readFile(rosterPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as { title?: string; members?: Record<string, Record<string, unknown>> };
  } catch {
    return undefined;
  }
}

export async function discoverAgySwarmDir(
  conversationId: string | undefined,
  brainDir = agyBrainDir(),
  options?: { scanParentSwarms?: boolean },
): Promise<{ swarmId: string; dir: string; currentMember?: string } | undefined> {
  if (!conversationId) return undefined;
  const normalizedTarget = conversationId.trim().toLowerCase();
  const ownDir = path.join(brainDir, conversationId, ".system_generated", "swarm");
  if (existsSync(path.join(ownDir, "members.json"))) {
    return { swarmId: conversationId, dir: ownDir };
  }
  if (!options?.scanParentSwarms) {
    return undefined;
  }

  let dirs: string[];
  try {
    dirs = await fs.readdir(brainDir);
  } catch {
    return undefined;
  }
  for (const dirName of dirs) {
    if (!UUID_RE.test(dirName)) continue;
    const candidateDir = path.join(brainDir, dirName, ".system_generated", "swarm");
    const roster = await readRosterJson(path.join(candidateDir, "members.json"));
    if (!roster?.members || typeof roster.members !== "object") continue;
    for (const [name, member] of Object.entries(roster.members)) {
      const memberConv =
        typeof member?.conversation_id === "string"
          ? member.conversation_id.trim().toLowerCase()
          : "";
      if (memberConv && memberConv === normalizedTarget) {
        return { swarmId: dirName, dir: candidateDir, currentMember: name };
      }
    }
  }
  return undefined;
}

export async function collectSwarmMemberConversationIds(
  conversationId: string,
  brainDir = agyBrainDir(),
): Promise<string[]> {
  const rosterPath = path.join(
    brainDir,
    conversationId,
    ".system_generated",
    "swarm",
    "members.json",
  );
  const roster = await readRosterJson(rosterPath);
  if (!roster?.members) return [];
  const ids: string[] = [];
  for (const member of Object.values(roster.members)) {
    const cid =
      typeof member?.conversation_id === "string" ? member.conversation_id.trim().toLowerCase() : "";
    if (cid && UUID_RE.test(cid)) ids.push(cid);
  }
  return ids;
}

export async function readAgySwarmSnapshot(
  conversationId: string | undefined,
  options?: { brainDir?: string; nowMs?: number; scanParentSwarms?: boolean },
): Promise<AgySwarmSnapshot | undefined> {
  const brainDir = options?.brainDir ?? agyBrainDir();
  const discovered = await discoverAgySwarmDir(conversationId, brainDir, {
    scanParentSwarms: options?.scanParentSwarms,
  });
  if (!discovered) return undefined;

  const rosterPath = path.join(discovered.dir, "members.json");
  const boardPath = path.join(discovered.dir, "board.jsonl");
  const roster = await readRosterJson(rosterPath);
  if (!roster?.members || typeof roster.members !== "object") return undefined;

  let newestUpdateMs = 0;
  try {
    newestUpdateMs = Math.max(newestUpdateMs, (await fs.stat(rosterPath)).mtimeMs);
  } catch {}
  try {
    newestUpdateMs = Math.max(newestUpdateMs, (await fs.stat(boardPath)).mtimeMs);
  } catch {}

  const memberNames = Object.keys(roster.members).filter(
    (n) => roster.members![n] && typeof roster.members![n] === "object",
  );

  const posts: AgySwarmPost[] = [];
  const postStats = new Map<string, { count: number; lastSeq: number }>();
  try {
    const rawBoard = await fs.readFile(boardPath, "utf-8");
    for (const line of rawBoard.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      const seq = Number(parsed.seq) || posts.length + 1;
      const agent = String(parsed.agent ?? "");
      const text = String(parsed.text ?? "");
      const time = typeof parsed.time === "string" ? parsed.time : "";
      const ts = time ? Date.parse(time.replace(" ", "T")) : Number.NaN;
      const channel =
        typeof parsed.channel === "string" && parsed.channel && parsed.channel !== "main"
          ? parsed.channel
          : undefined;
      const control =
        typeof parsed.control === "string" && parsed.control ? parsed.control : undefined;
      const { mentions, all } = control
        ? { mentions: [], all: false }
        : extractSwarmMentions(text, memberNames);
      posts.push({
        seq,
        agent,
        text,
        time,
        ts: Number.isFinite(ts) ? ts : undefined,
        channel,
        control,
        mentions,
        all,
      });
      if (!control && agent) {
        const prev = postStats.get(agent);
        postStats.set(agent, { count: (prev?.count ?? 0) + 1, lastSeq: seq });
      }
    }
  } catch {
    // board.jsonl may not exist until the first post lands.
  }

  const headSeq = posts.length > 0 ? posts[posts.length - 1]!.seq : 0;
  const now = options?.nowMs ?? Date.now();

  const transcripts = await Promise.all(
    memberNames.map(async (name) => {
      const rawMember = roster.members![name]!;
      const cid =
        typeof rawMember.conversation_id === "string"
          ? rawMember.conversation_id.trim()
          : undefined;
      const summary = await readMemberTranscript(brainDir, cid);
      return [name, summary] as const;
    }),
  );
  const transcriptByName = new Map(transcripts);

  let narratorConvId: string | undefined;
  let coordinatorConvId = discovered.swarmId;
  let workingCount = 0;
  let waitingCount = 0;
  let stoppedCount = 0;
  let killedCount = 0;
  let failedCount = 0;

  const members: AgySwarmMember[] = memberNames.map((name) => {
    const raw = roster.members![name]!;
    const cid =
      typeof raw.conversation_id === "string" && raw.conversation_id.trim()
        ? raw.conversation_id.trim()
        : undefined;
    const role = typeof raw.role === "string" ? raw.role : undefined;
    if (role === "coordinator" && cid) coordinatorConvId = cid;
    if ((role === "narrator" || /^narrator(?:-\d+)?$/i.test(name)) && cid) {
      narratorConvId = cid;
    }
    const killed = Boolean(raw.killed);
    const tr = transcriptByName.get(name);
    if (tr?.mtimeMs) newestUpdateMs = Math.max(newestUpdateMs, tr.mtimeMs);

    let status: AgySwarmMemberStatus;
    if (killed) status = "killed";
    else if (tr?.idle) status = "waiting";
    else if (tr) status = "working";
    else if (raw.wake_mode === "mentions" || raw.wake_mode === "anything") status = "waiting";
    else if (raw.wake_mode === "working") status = "working";
    else status = "stopped";

    let failure: { kind: "quota" | "error"; text: string } | undefined;
    if (!killed && tr?.lastStep) {
      const isModelErr = tr.lastStep.type === "ERROR_MESSAGE";
      const isSettledToolErr =
        tr.lastStep.status === "ERROR" && now - tr.mtimeMs >= STEP_ERROR_SETTLE_MS;
      if (isModelErr || isSettledToolErr) {
        const msg = tr.lastStep.error || (isModelErr ? "model error" : "step failed");
        failure = { kind: QUOTA_RE.test(msg) ? "quota" : "error", text: msg };
        failedCount += 1;
      }
    }

    if (status === "killed") killedCount += 1;
    else if (status === "waiting") waitingCount += 1;
    else if (status === "working") workingCount += 1;
    else stoppedCount += 1;

    const lastReadSeq = typeof raw.last_read_seq === "number" ? raw.last_read_seq : 0;
    const stats = postStats.get(name);
    return {
      name,
      conversationId: cid,
      model: typeof raw.model === "string" && raw.model ? raw.model : undefined,
      role,
      wakeMode: typeof raw.wake_mode === "string" && raw.wake_mode ? raw.wake_mode : undefined,
      waitSince: typeof raw.wait_since === "number" ? raw.wait_since : undefined,
      lastReadSeq,
      killed,
      status,
      activity: status === "working" ? tr?.activity : undefined,
      activityKind: status === "working" ? tr?.activityKind : undefined,
      steps: tr?.steps,
      failure,
      unread: Math.max(0, headSeq - lastReadSeq),
      postCount: stats?.count ?? 0,
      lastPostSeq: stats?.lastSeq,
      transcriptMtime: tr?.mtimeMs,
    };
  });

  // Sort coordinator first, workers next, role workers (monitor/narrator) last.
  members.sort((a, b) => {
    const rank = (m: AgySwarmMember) =>
      m.role === "coordinator" || m.name === "coordinator"
        ? 0
        : ROLE_WORKER_NAME_RE.test(m.name)
          ? 2
          : 1;
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });

  let headline: string | undefined;
  let phase: { label?: string; index?: number; total?: number } | undefined;
  const viewCandidates = [
    path.join(discovered.dir, "view.json"),
    ...(narratorConvId
      ? [path.join(brainDir, narratorConvId, "swarm_view", "view.json")]
      : []),
  ];
  for (const vp of viewCandidates) {
    try {
      const st = await fs.stat(vp);
      if (st.size > 0 && st.size <= VIEW_MAX_BYTES) {
        const parsed = JSON.parse(await fs.readFile(vp, "utf-8")) as Record<string, unknown>;
        if (typeof parsed.headline === "string" && parsed.headline.trim()) {
          headline = parsed.headline.trim();
        }
        if (parsed.phase && typeof parsed.phase === "object") {
          const p = parsed.phase as Record<string, unknown>;
          phase = {
            label: typeof p.label === "string" ? p.label : undefined,
            index: typeof p.index === "number" ? p.index : undefined,
            total: typeof p.total === "number" ? p.total : undefined,
          };
        }
        break;
      }
    } catch {
      // Ignore missing or half-written view.json.
    }
  }

  const latestPost = posts.length > 0 ? posts[posts.length - 1] : undefined;
  const coord = members.find((m) => m.role === "coordinator" || m.name === "coordinator");
  // A coordinator reply without tool calls means it paused to talk to the user
  // (or ended Turn 1 so native board tools unlock), not that the swarm finished.
  const done = posts.some(
    (p) =>
      (p.agent === "coordinator" || p.agent === coord?.name) &&
      !p.all &&
      p.mentions.length === 0 &&
      isDoneBoardPost(p.text),
  );

  const title =
    typeof roster.title === "string" && roster.title.trim()
      ? roster.title.trim()
      : discovered.swarmId.slice(0, 8);

  return {
    swarmId: discovered.swarmId,
    coordinatorConversationId: coordinatorConvId,
    dir: discovered.dir,
    title,
    currentMember: discovered.currentMember,
    members,
    posts,
    headSeq,
    latestPost,
    workingCount,
    waitingCount,
    stoppedCount,
    killedCount,
    failedCount,
    done,
    headline,
    phase,
    newestUpdateMs,
  };
}

/**
 * Liveness probe for Pi's stall watchdog while the coordinator is parked inside
 * `swarm_wait`. Counts any non-killed working member (or recent board/transcript
 * activity) so the coordinator turn is never killed mid-swarm.
 */
export async function agyProbeSwarm(
  conversationId: string | undefined,
  brainDir = agyBrainDir(),
): Promise<AgySwarmProbeResult> {
  const snapshot = await readAgySwarmSnapshot(conversationId, { brainDir });
  if (!snapshot || snapshot.done) {
    return { hasAlive: false, aliveCount: 0, newestUpdateMs: 0 };
  }
  const activeWorkers = snapshot.members.filter(
    (m) =>
      !m.killed &&
      m.role !== "coordinator" &&
      m.name !== "coordinator" &&
      m.status === "working",
  );
  return {
    hasAlive: activeWorkers.length > 0,
    aliveCount: activeWorkers.length,
    newestUpdateMs: snapshot.newestUpdateMs,
  };
}

export interface AgySwarmCoordinatorWake {
  maxSeq: number;
  unreadMentionCount: number;
  latestPost: AgySwarmPost;
}

/**
 * Detect whether the coordinator is parked/idle in Pi while unread worker posts
 * mentioning `@coordinator` (or `@all`) have arrived on the board.
 */
export function findPendingSwarmCoordinatorWake(
  snapshot: AgySwarmSnapshot,
  lastWokenSeq = 0,
): AgySwarmCoordinatorWake | undefined {
  if (snapshot.done) return undefined;
  const coord = snapshot.members.find((m) => m.role === "coordinator" || m.name === "coordinator");
  if (!coord || coord.killed || coord.status === "working") return undefined;

  const coordLower = coord.name.toLowerCase();
  const seenSeq = Math.max(coord.lastReadSeq ?? 0, lastWokenSeq);
  const unreadMentions = snapshot.posts.filter(
    (p) =>
      !p.control &&
      p.seq > seenSeq &&
      p.agent.toLowerCase() !== coordLower &&
      (p.all || p.mentions.some((m) => m.toLowerCase() === coordLower)),
  );
  if (unreadMentions.length === 0) return undefined;

  const latestPost = unreadMentions[unreadMentions.length - 1]!;
  return {
    maxSeq: latestPost.seq,
    unreadMentionCount: unreadMentions.length,
    latestPost,
  };
}

export function buildSwarmCoordinatorWakePrompt(
  _snapshot: AgySwarmSnapshot,
  wake: AgySwarmCoordinatorWake,
): string {
  const from = wake.latestPost.agent ? `@${wake.latestPost.agent}` : "a worker";
  const countLabel =
    wake.unreadMentionCount === 1
      ? "A new board post"
      : `${wake.unreadMentionCount} new board posts`;
  return [
    `[System wakeup: ${countLabel} mentioning @coordinator arrived (up to #${wake.maxSeq}, latest from ${from}).]`,
    "Call `read_board` and `swarm{action:\"status\"}` now to review the updates, coordinate any remaining work or `swarm_wait`, and when finished post `[done] <summary>` (with no `@`) on the board before reporting the final summary to the user.",
  ].join("\n");
}

export function formatSwarmWidgetHint(
  snapshot: AgySwarmSnapshot,
  theme?: Pick<Theme, "fg">,
): string {
  const fg = (color: Parameters<Theme["fg"]>[0], text: string) =>
    theme ? theme.fg(color, text) : text;
  const workerCount = snapshot.members.filter(
    (m) => m.role !== "coordinator" && m.name !== "coordinator",
  ).length;
  const statusTag = snapshot.done
    ? fg("success", "Done")
    : snapshot.workingCount > 0
      ? fg("warning", `${snapshot.workingCount} working`)
      : fg("dim", "waiting");
  const postTail = snapshot.latestPost
    ? fg("dim", ` · #${snapshot.latestPost.seq} ${snapshot.latestPost.agent}`)
    : "";
  return (
    fg("accent", "🐝 ") +
    fg("text", `Swarm(${snapshot.title})`) +
    fg("dim", ` · ${workerCount}w · `) +
    statusTag +
    postTail +
    fg("dim", " • ") +
    fg("accent", "/swarm board") +
    fg("dim", " (alt+s)")
  );
}

export function formatSwarmTextSummary(snapshot: AgySwarmSnapshot): string {
  const lines: string[] = [
    `Swarm: ${snapshot.title} (${snapshot.swarmId.slice(0, 8)}) — ${
      snapshot.done ? "Done" : `${snapshot.workingCount} working, ${snapshot.waitingCount} waiting`
    }`,
  ];
  if (snapshot.headline) lines.push(`Overview: ${snapshot.headline}`);
  lines.push("", "Roster:");
  for (const m of snapshot.members) {
    const icon =
      m.status === "working"
        ? "●"
        : m.status === "waiting"
          ? "○"
          : m.status === "killed"
            ? "✕"
            : "◌";
    const meta = [m.status, m.model, m.unread > 0 ? `${m.unread} unread` : ""]
      .filter(Boolean)
      .join(" · ");
    const extra = m.failure
      ? ` — ${m.failure.kind}: ${m.failure.text}`
      : m.activity
        ? ` — ${m.activity}`
        : "";
    lines.push(`  ${icon} ${m.name} (${meta})${extra}`);
  }
  if (snapshot.posts.length > 0) {
    lines.push("", "Recent posts:");
    for (const p of snapshot.posts.slice(-6)) {
      lines.push(`  #${p.seq} @${p.agent}: ${oneLine(p.text, 90)}`);
    }
  }
  lines.push("", "Run /swarm board (or alt+s) for live interactive view.");
  return lines.join("\n");
}
