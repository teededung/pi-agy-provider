import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgyPiBridge } from "../lib/bridge.ts";
import { ALL_FALLBACK_MODELS } from "../lib/models.ts";
import { formatAgyCall } from "../lib/render.ts";
import {
  formatAgySubagentsLivePreviewLines,
  reconcileAgySubagentRosterWithSwarm,
  summarizeAgySubagentsWidget,
  syncAgySubagentRoster,
  type AgySubagentEntry,
} from "../lib/subagents.ts";
import { AgyReplayStore } from "../lib/replay.ts";
import {
  agyProbeSwarm,
  buildSwarmCoordinatorWakePrompt,
  collectSwarmMemberConversationIds,
  discoverAgySwarmDir,
  findPendingSwarmCoordinatorWake,
  formatSwarmTextSummary,
  formatSwarmWidgetHint,
  readAgySwarmSnapshot,
} from "../lib/swarm.ts";
import { agyProbeSubagents } from "../lib/tasks.ts";
import { contextHasPriorSwarmActivity, streamAntigravity } from "../src/provider.ts";
import { AntigravityRuntime, createAntigravityRuntime } from "../src/runtime.ts";
import { AgySwarmBoardDashboard, filterSwarmPosts } from "../src/swarm-ui.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Parameters<typeof formatSwarmWidgetHint>[1] &
  Parameters<typeof formatAgyCall>[2] &
  ConstructorParameters<typeof AgySwarmBoardDashboard>[1];

test("readAgySwarmSnapshot, agyProbeSwarm, and agyProbeSubagents read roster, board, transcripts, and done state", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agy-swarm-"));
  const brainDir = path.join(root, "brain");
  const coordId = "11111111-1111-4111-8111-111111111111";
  const workerId = "22222222-2222-4222-8222-222222222222";
  const verifierId = "33333333-3333-4333-8333-333333333333";
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const swarmDir = path.join(brainDir, coordId, ".system_generated", "swarm");
  const workerLogDir = path.join(brainDir, workerId, ".system_generated", "logs");
  const verifierLogDir = path.join(brainDir, verifierId, ".system_generated", "logs");
  await Promise.all([
    mkdir(swarmDir, { recursive: true }),
    mkdir(workerLogDir, { recursive: true }),
    mkdir(verifierLogDir, { recursive: true }),
  ]);

  await writeFile(
    path.join(swarmDir, "members.json"),
    JSON.stringify({
      title: "parser rewrite",
      members: {
        coordinator: {
          conversation_id: coordId,
          model: "gemini-4-hydrogen-high",
          role: "coordinator",
        },
        parser: {
          conversation_id: workerId,
          model: "gemini-4-carbon-medium",
          role: "worker",
          wake_mode: "mentions",
          last_read_seq: 1,
        },
        verifier: {
          conversation_id: verifierId,
          model: "gemini-4-carbon-medium",
          role: "worker",
          wake_mode: "mentions",
          last_read_seq: 2,
        },
      },
    }),
  );

  await writeFile(
    path.join(swarmDir, "board.jsonl"),
    [
      JSON.stringify({
        seq: 1,
        agent: "coordinator",
        text: "@parser fix parser bug",
        time: "2026-11-16T06:00:00Z",
      }),
      JSON.stringify({
        seq: 2,
        agent: "parser",
        text: "@verifier check fix",
        time: "2026-11-16T06:01:00Z",
      }),
    ].join("\n") + "\n",
  );

  await writeFile(
    path.join(swarmDir, "view.json"),
    JSON.stringify({ headline: "Parser patch under verification" }),
  );

  // Worker mid-turn running a command; verifier parked in swarm_wait.
  await writeFile(
    path.join(workerLogDir, "transcript.jsonl"),
    JSON.stringify({
      step_index: 0,
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { command: "bun test" } }],
    }) + "\n",
  );
  await writeFile(
    path.join(verifierLogDir, "transcript.jsonl"),
    [
      JSON.stringify({
        step_index: 0,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "swarm_wait", args: { since: 2 } }],
      }),
      JSON.stringify({ step_index: 1, type: "GENERIC", status: "DONE" }),
    ].join("\n") + "\n",
  );

  // Default discovery stays local to the conversation; parent scan must be opted in.
  assert.equal(await discoverAgySwarmDir(workerId, brainDir), undefined);
  const discoveredFromWorker = await discoverAgySwarmDir(workerId, brainDir, {
    scanParentSwarms: true,
  });
  assert.equal(discoveredFromWorker?.swarmId, coordId);
  assert.equal(discoveredFromWorker?.currentMember, "parser");

  const ids = await collectSwarmMemberConversationIds(coordId, brainDir);
  assert.deepEqual(ids.sort(), [coordId, workerId, verifierId].sort());

  const snap = await readAgySwarmSnapshot(coordId, { brainDir });
  assert.ok(snap);
  assert.equal(snap.title, "parser rewrite");
  assert.equal(snap.headline, "Parser patch under verification");
  assert.equal(snap.workingCount, 1);
  assert.equal(snap.done, false);
  const parser = snap.members.find((m) => m.name === "parser")!;
  assert.equal(parser.status, "working");
  assert.equal(parser.unread, 1);
  assert.equal(parser.activity, "run_command");
  const verifier = snap.members.find((m) => m.name === "verifier")!;
  assert.equal(verifier.status, "waiting");

  const swarmProbe = await agyProbeSwarm(coordId, brainDir);
  assert.equal(swarmProbe.hasAlive, true);
  assert.equal(swarmProbe.aliveCount, 1);

  const subProbe = await agyProbeSubagents(coordId, brainDir);
  assert.equal(subProbe.hasAlive, true);

  assert.match(formatSwarmWidgetHint(snap, plainTheme), /🐝 Swarm\(parser rewrite\).*1 working.*\/swarm board/);
  assert.match(formatSwarmTextSummary(snap), /Swarm: parser rewrite/);

  // Once coordinator posts [done], snapshot marks done and probe stops holding stall watchdog.
  await writeFile(
    path.join(swarmDir, "board.jsonl"),
    [
      JSON.stringify({ seq: 1, agent: "coordinator", text: "@parser fix parser bug", time: "2026-11-16T06:00:00Z" }),
      JSON.stringify({ seq: 2, agent: "parser", text: "@verifier check fix", time: "2026-11-16T06:01:00Z" }),
      JSON.stringify({ seq: 3, agent: "coordinator", text: "[done] Parser fixed and verified.", time: "2026-11-16T06:02:00Z" }),
    ].join("\n") + "\n",
  );
  const doneSnap = await readAgySwarmSnapshot(coordId, { brainDir });
  assert.equal(doneSnap?.done, true);
  assert.equal((await agyProbeSwarm(coordId, brainDir)).hasAlive, false);

  // Starting a new wave on the same board (new coordinator brief after earlier `[done]`)
  // must flip `done` back to `false` until the new wave posts its own `[done]`.
  await writeFile(
    path.join(swarmDir, "board.jsonl"),
    [
      JSON.stringify({ seq: 1, agent: "coordinator", text: "@coder Rewrite parser.ts", time: "2026-11-16T06:00:00Z" }),
      JSON.stringify({ seq: 2, agent: "coder", text: "@coordinator [done] Parser rewritten", time: "2026-11-16T06:01:00Z" }),
      JSON.stringify({ seq: 3, agent: "coordinator", text: "[done] Wave 1 complete.", time: "2026-11-16T06:02:00Z" }),
      JSON.stringify({ seq: 4, agent: "coordinator", text: "@coder Start Wave 2", time: "2026-11-16T06:05:00Z" }),
    ].join("\n") + "\n",
  );
  const wave2Snap = await readAgySwarmSnapshot(coordId, { brainDir });
  assert.equal(wave2Snap?.done, false);
  assert.doesNotMatch(formatSwarmWidgetHint(wave2Snap!, plainTheme), /\bDone\b/);
  await writeFile(
    path.join(swarmDir, "board.jsonl"),
    [
      JSON.stringify({ seq: 1, agent: "coordinator", text: "@coder Rewrite parser.ts", time: "2026-11-16T06:00:00Z" }),
      JSON.stringify({ seq: 2, agent: "coder", text: "@coordinator [done] Parser rewritten", time: "2026-11-16T06:01:00Z" }),
      JSON.stringify({ seq: 3, agent: "coordinator", text: "[done] Wave 1 complete.", time: "2026-11-16T06:02:00Z" }),
      JSON.stringify({ seq: 4, agent: "coordinator", text: "@coder Start Wave 2", time: "2026-11-16T06:05:00Z" }),
      JSON.stringify({ seq: 5, agent: "coordinator", text: "[done] Wave 2 complete.", time: "2026-11-16T06:06:00Z" }),
    ].join("\n") + "\n",
  );
  const wave2DoneSnap = await readAgySwarmSnapshot(coordId, { brainDir });
  assert.equal(wave2DoneSnap?.done, true);
});

test("AgySwarmBoardDashboard renders panes, steps posts, filters by member, and zooms", () => {
  const snap = {
    swarmId: "swarm-1",
    coordinatorConversationId: "coord-1",
    dir: "/tmp/swarm",
    title: "refactor board",
    members: [
      {
        name: "coordinator",
        role: "coordinator",
        killed: false,
        status: "waiting" as const,
        unread: 0,
        postCount: 1,
      },
      {
        name: "coder",
        role: "worker",
        model: "gemini-4-carbon",
        killed: false,
        status: "working" as const,
        activity: "Edit parser.ts",
        unread: 0,
        postCount: 1,
      },
    ],
    posts: [
      {
        seq: 1,
        agent: "coordinator",
        text: "@coder fix #1",
        time: "2026-11-16T06:00:00Z",
        mentions: ["coder"],
        all: false,
      },
      {
        seq: 2,
        agent: "coder",
        text: "@coordinator [done] fixed",
        time: "2026-11-16T06:01:00Z",
        mentions: ["coordinator"],
        all: false,
      },
    ],
    headSeq: 2,
    latestPost: undefined,
    workingCount: 1,
    waitingCount: 1,
    stoppedCount: 0,
    killedCount: 0,
    failedCount: 0,
    done: false,
    newestUpdateMs: 1,
  };

  assert.equal(filterSwarmPosts(snap.posts, "coder").length, 2);

  let closed = false;
  const fakeTui = {
    requestRender() {},
    terminal: { rows: 32, columns: 100 },
  } as unknown as ConstructorParameters<typeof AgySwarmBoardDashboard>[0];
  const fakeKb = {
    matches: (data: string, key: string) =>
      (key === "tui.select.cancel" && data === "\x1b") ||
      (key === "tui.select.down" && data === "down") ||
      (key === "tui.select.up" && data === "up"),
  } as unknown as ConstructorParameters<typeof AgySwarmBoardDashboard>[2];

  const dash = new AgySwarmBoardDashboard(
    fakeTui,
    plainTheme,
    fakeKb,
    snap,
    async () => snap,
    () => {
      closed = true;
    },
  );

  const initialOut = dash.render(100).join("\n");
  assert.match(initialOut, /🐝 Swarm\(refactor board\)/);
  assert.match(initialOut, /┌─ Roster \(2\)/);
  assert.match(initialOut, /┏━ ● Posts \(2\)/);
  assert.match(initialOut, /Message #2 · @coder/);
  // Posts pane shows newest post (#2) above older post (#1).
  assert.ok(initialOut.indexOf("#2 @coder") < initialOut.indexOf("#1 @coordinator"));

  // Left arrow jumps straight to Roster; ↑/↓ selects member; Right arrow returns to Posts.
  dash.handleInput("\x1b[D");
  dash.handleInput("down"); // selects "coder"
  dash.handleInput("p"); // filter by selected member ("coder")
  assert.match(dash.render(100).join("\n"), /filter:@coder/);
  dash.handleInput("p"); // clear filter
  dash.handleInput("\x1b[C"); // right arrow back to posts

  // Mouse click on Roster row 1 ("coder") focuses Roster and selects "coder"; click on Posts row 1 selects older #1.
  dash.render(100);
  dash.handleMouse({
    type: "press",
    button: "left",
    x: 5,
    y: 3, // headerRows=1, top border=1, row 0=coordinator (y=2), row 1=coder (y=3)
    screenX: 5,
    screenY: 3,
    width: 100,
    height: 28,
    shift: false,
    alt: false,
    ctrl: false,
  });
  dash.handleInput("z");
  assert.match(dash.render(100).join("\n"), /zoom:roster/);
  dash.handleInput("z"); // unzoom
  dash.render(100);
  dash.handleMouse({
    type: "press",
    button: "left",
    x: 50,
    y: 3, // second row in newest-first order (#1 @coordinator)
    screenX: 50,
    screenY: 3,
    width: 100,
    height: 28,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.match(dash.render(100).join("\n"), /Message #1 · @coordinator/);

  // Kitty Shift+Tab (`\x1b[9;2u`) cycles backwards from posts -> roster.
  dash.handleInput("\x1b[9;2u");
  dash.handleInput("z");
  assert.match(dash.render(100).join("\n"), /zoom:roster/);
  dash.handleInput("z"); // unzoom

  // Step forward `]` back to #2, then `[` back to #1, zoom in, unzoom and close.
  dash.handleInput("\x1b[C"); // focus posts
  dash.handleInput("]");
  assert.match(dash.render(100).join("\n"), /Message #2 · @coder/);
  dash.handleInput("[");
  assert.match(dash.render(100).join("\n"), /Message #1 · @coordinator/);
  dash.handleInput("z");
  assert.match(dash.render(100).join("\n"), /zoom:posts/);
  dash.handleInput("\x1b"); // unzooms first
  assert.equal(closed, false);
  dash.handleInput("\x1b"); // closes
  assert.equal(closed, true);
  dash.dispose();
});

test("reconcileAgySubagentRosterWithSwarm freezes elapsed time for sleeping/done swarm workers so footer stops ticking", () => {
  const t0 = 1_700_000_000_000;
  const tDone = t0 + 95_000; // finished in 1m35s
  const tLater = t0 + 25 * 60_000; // 25 minutes later

  const roster = new Map<string, AgySubagentEntry>([
    [
      "step-1",
      {
        key: "step-1",
        name: "Swarm Worker (translator-4)",
        typeName: "worker",
        tool: "invoke_subagent",
        status: "running",
        startedAtMs: t0,
        lastUpdatedAtMs: tDone,
        lastActivity: "step 21 · post_message",
        conversationId: "aaaa1111-1111-4111-8111-111111111111",
        messages: 0,
      },
    ],
    [
      "step-2",
      {
        key: "step-2",
        name: "Swarm Worker (verifier)",
        typeName: "worker",
        tool: "invoke_subagent",
        status: "running",
        startedAtMs: t0,
        lastUpdatedAtMs: tDone,
        lastActivity: "step 12 · post_message",
        conversationId: "bbbb2222-2222-4222-8222-222222222222",
        messages: 0,
      },
    ],
  ]);

  const doneSwarm = {
    swarmId: "swarm-1",
    coordinatorConversationId: "coord-1",
    dir: "/tmp/swarm",
    title: "LaniRO Wave 1",
    members: [
      {
        name: "translator-4",
        conversationId: "aaaa1111-1111-4111-8111-111111111111",
        killed: false,
        status: "waiting" as const,
        unread: 0,
        postCount: 1,
        transcriptMtime: tDone,
      },
      {
        name: "verifier",
        conversationId: "bbbb2222-2222-4222-8222-222222222222",
        killed: false,
        status: "waiting" as const,
        unread: 0,
        postCount: 1,
        transcriptMtime: tDone,
      },
    ],
    posts: [],
    headSeq: 16,
    workingCount: 0,
    waitingCount: 2,
    stoppedCount: 0,
    killedCount: 0,
    failedCount: 0,
    done: true,
    newestUpdateMs: tDone,
  };

  assert.equal(reconcileAgySubagentRosterWithSwarm(roster, doneSwarm), true);
  assert.equal(roster.get("step-1")?.status, "done");
  assert.equal(roster.get("step-1")?.durationSeconds, 95);
  assert.equal(roster.get("step-2")?.status, "done");
  assert.equal(roster.get("step-2")?.durationSeconds, 95);

  // Live preview clears finished swarm workers, and summary freezes at 1m35s even 25 minutes later!
  assert.deepEqual(formatAgySubagentsLivePreviewLines(roster, tLater), []);
  assert.equal(summarizeAgySubagentsWidget(roster, tLater), "2 tracked (done · 1m35s)");

  // If a worker wakes up again for Wave 2, it returns to running.
  doneSwarm.members[0]!.status = "working" as any;
  assert.equal(reconcileAgySubagentRosterWithSwarm(roster, doneSwarm), true);
  assert.equal(roster.get("step-1")?.status, "running");
  assert.equal(roster.get("step-1")?.durationSeconds, undefined);

  // Long swarm titles truncate cleanly so `/swarm board` stays visible in the status widget.
  const longHint = formatSwarmWidgetHint(
    {
      ...doneSwarm,
      title: "LaniRO Wave 3 (3.8-3.14) EN Translation Full Batch",
    },
    plainTheme,
  );
  assert.match(longHint, /Swarm\(LaniRO Wave 3 \(3\.8-3\.14\) EN…\)/);
  assert.match(longHint, /\/swarm board/);
});

test("streamAntigravity expands /swarm, drops pi-tools restriction, uses continuation, and deactivates cleanly", async (t) => {
  const seenRequests: Array<{ prompt: string; agent?: string; timeoutMs?: number }> = [];
  const runtime = createAntigravityRuntime(async (request) => {
    seenRequests.push({
      prompt: request.prompt,
      agent: request.agent,
      timeoutMs: request.timeoutMs,
    });
    request.onConversation?.("swarm-conv-1");
    const result = {
      type: "result" as const,
      status: "OK" as const,
      response: "Swarm update.",
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    };
    request.onActivity?.(result);
    return {
      conversationId: "swarm-conv-1",
      status: "OK",
      response: "Swarm update.",
      activities: [result],
      usage: result.usage,
      finished: true,
    };
  });
  t.after(() => runtime.dispose());

  let swarmActive = true;
  const service = runtime.runSync(AntigravityRuntime);
  const streamFn = streamAntigravity(
    runtime,
    service,
    new AgyReplayStore(),
    new AgyPiBridge("pi-test"),
    undefined,
    undefined,
    () => true,
    undefined,
    createAntigravityRuntime,
    () => undefined,
    () => ({ mode: "agent", agent: "pi-tools" }),
    () => undefined,
    () => "Relayed instructions",
    () => false,
    () => undefined,
    () => ALL_FALLBACK_MODELS,
    undefined,
    () => false,
    () => undefined,
    () => false,
    undefined,
    () => false,
    () => swarmActive,
  );

  const model = {
    id: "gemini-4-hydrogen",
    name: "Gemini 4 Hydrogen",
    api: "antigravity-stream-json",
    provider: "antigravity",
    baseUrl: "agy://local-stream-json",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  };

  for await (const _ of streamFn(model, {
    messages: [{ role: "user", content: "/swarm Audit and refactor parser" }],
  })) {
  }
  assert.match(seenRequests[0]!.prompt, /<SWARM>/);
  assert.match(seenRequests[0]!.prompt, /Audit and refactor parser/);
  assert.equal(seenRequests[0]!.agent, undefined);
  assert.equal(seenRequests[0]!.timeoutMs, 43_200_000);

  const history = [
    { role: "user", content: "/swarm Audit and refactor parser" },
    { role: "assistant", content: [{ type: "text", text: "Started swarm." }] },
  ];
  assert.equal(contextHasPriorSwarmActivity(history as any), true);

  for await (const _ of streamFn(model, {
    messages: [...history, { role: "user", content: "status?" }] as any,
  })) {
  }
  assert.match(seenRequests[1]!.prompt, /Swarm mode \(`<SWARM>`\) remains active/);
  assert.equal(seenRequests[1]!.agent, undefined);

  swarmActive = false;
  for await (const _ of streamFn(model, {
    messages: [...history, { role: "user", content: "fix one small typo directly" }] as any,
  })) {
  }
  assert.match(seenRequests[2]!.prompt, /Swarm mode is now OFF for this turn/);
  assert.equal(seenRequests[2]!.agent, "pi-tools");
});

test("formatAgyCall renders swarm, post_message, read_board, and swarm_wait cleanly", () => {
  assert.match(
    formatAgyCall("swarm", { action: "add", name: "parser", model: "gemini-4-carbon" }, plainTheme),
    /^swarm add parser \(gemini-4-carbon\)$/,
  );
  assert.match(
    formatAgyCall("post_message", { text: "@parser please check tests" }, plainTheme),
    /^post_message "@parser please check tests"$/,
  );
  assert.match(
    formatAgyCall("read_board", { since: 4, status: true }, plainTheme),
    /^read_board status since #4$/,
  );
  assert.match(
    formatAgyCall("swarm_wait", { since: 4, mentions_only: true }, plainTheme),
    /^swarm_wait since #4 mentions$/,
  );
});

test("swarm wake_mode working, Turn 1 coordinator reply, mention-guarded [done], board timestamps, and wakeup detection", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agy-swarm-fixes-"));
  const brainDir = path.join(root, "brain");
  const coordId = "aaaaaaaa-1111-4111-8111-111111111111";
  const workerId = "bbbbbbbb-2222-4222-8222-222222222222";
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const swarmDir = path.join(brainDir, coordId, ".system_generated", "swarm");
  const coordLogDir = path.join(brainDir, coordId, ".system_generated", "logs");
  await Promise.all([
    mkdir(swarmDir, { recursive: true }),
    mkdir(coordLogDir, { recursive: true }),
  ]);

  // Turn 1: coordinator ends its turn with a reply (no tool calls) while worker has
  // wake_mode: "working" and no transcript.jsonl yet.
  await writeFile(
    path.join(swarmDir, "members.json"),
    JSON.stringify({
      title: "wake & status check",
      members: {
        coordinator: {
          conversation_id: coordId,
          role: "coordinator",
          wake_mode: "mentions",
          last_read_seq: 0,
        },
        builder: {
          conversation_id: workerId,
          role: "worker",
          wake_mode: "working",
          last_read_seq: 0,
        },
      },
    }),
  );
  await writeFile(
    path.join(coordLogDir, "transcript.jsonl"),
    JSON.stringify({
      step_index: 0,
      type: "PLANNER_RESPONSE",
      tool_calls: [],
    }) + "\n",
  );

  const initial = await readAgySwarmSnapshot(coordId, { brainDir });
  assert.ok(initial);
  const builder = initial.members.find((m) => m.name === "builder")!;
  assert.equal(builder.status, "working");
  assert.equal(initial.done, false);
  assert.equal((await agyProbeSwarm(coordId, brainDir)).hasAlive, true);
  assert.equal(findPendingSwarmCoordinatorWake(initial), undefined);

  // Worker posts with space-separated board timestamp and mentions @coordinator.
  // Coordinator's own [done] post that still @mentions someone must not end the swarm.
  await writeFile(
    path.join(swarmDir, "board.jsonl"),
    [
      JSON.stringify({
        seq: 1,
        agent: "coordinator",
        text: "@builder [done] wait actually check tests",
        time: "2026-11-16 15:30:00",
      }),
      JSON.stringify({
        seq: 2,
        agent: "builder",
        text: "@coordinator [done] tests pass",
        time: "2026-11-16 15:31:05",
      }),
    ].join("\n") + "\n",
  );

  const afterWorker = await readAgySwarmSnapshot(coordId, { brainDir });
  assert.ok(afterWorker);
  assert.equal(afterWorker.done, false);
  assert.ok(Number.isFinite(afterWorker.posts[1]!.ts));
  const coordMember = afterWorker.members.find((m) => m.name === "coordinator")!;
  assert.equal(coordMember.unread, 2);

  const wake = findPendingSwarmCoordinatorWake(afterWorker);
  assert.ok(wake);
  assert.equal(wake.maxSeq, 2);
  assert.equal(wake.unreadMentionCount, 1);
  assert.match(buildSwarmCoordinatorWakePrompt(afterWorker, wake), /#2.*@builder/);
  // Already woken through seq 2 -> does not re-trigger.
  assert.equal(findPendingSwarmCoordinatorWake(afterWorker, 2), undefined);

  // Coordinator posts final [done] without @mention -> swarm marks done and stops waking.
  await writeFile(
    path.join(swarmDir, "board.jsonl"),
    [
      JSON.stringify({
        seq: 1,
        agent: "coordinator",
        text: "@builder [done] wait actually check tests",
        time: "2026-11-16 15:30:00",
      }),
      JSON.stringify({
        seq: 2,
        agent: "builder",
        text: "@coordinator [done] tests pass",
        time: "2026-11-16 15:31:05",
      }),
      JSON.stringify({
        seq: 3,
        agent: "coordinator",
        text: "[done] All tests verified.",
        time: "2026-11-16 15:32:00",
      }),
    ].join("\n") + "\n",
  );
  const finished = await readAgySwarmSnapshot(coordId, { brainDir });
  assert.ok(finished);
  assert.equal(finished.done, true);
  assert.equal(findPendingSwarmCoordinatorWake(finished), undefined);
});

test("syncAgySubagentRoster preserves distinct keys for batch-spawned swarm workers sharing spawnStepIndex and avoids running/done flapping", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agy-swarm-batch-keys-"));
  const brainDir = path.join(root, "brain");
  const coordId = "aaaaaaaa-1111-4111-8111-111111111111";
  const workers = [
    { name: "translator-8-1", cid: "11111111-1111-4111-8111-111111111111" },
    { name: "translator-8-2", cid: "22222222-2222-4222-8222-222222222222" },
    { name: "translator-8-3", cid: "33333333-3333-4333-8333-333333333333" },
  ];
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const subDir = path.join(brainDir, coordId, ".system_generated", "subagents");
  const swarmDir = path.join(brainDir, coordId, ".system_generated", "swarm");
  await Promise.all([mkdir(subDir, { recursive: true }), mkdir(swarmDir, { recursive: true })]);

  const members: Record<string, unknown> = {
    coordinator: { conversation_id: coordId, role: "coordinator", wake_mode: "mentions" },
  };
  for (const w of workers) {
    // All workers in one `swarm add` batch share the exact same spawnStepIndex!
    await writeFile(
      path.join(subDir, `${w.cid}.json`),
      JSON.stringify({
        conversationId: w.cid,
        subagentDescriptor: { typeName: "worker", role: `Swarm Worker (${w.name})` },
        state: "SUBAGENT_STATE_ALIVE",
        spawnStepIndex: 2879,
      }),
    );
    const logDir = path.join(brainDir, w.cid, ".system_generated", "logs");
    await mkdir(logDir, { recursive: true });
    await writeFile(
      path.join(logDir, "transcript.jsonl"),
      [
        JSON.stringify({
          step_index: 16,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: "2026-11-25T13:19:15Z",
          tool_calls: [{ name: "post_message" }, { name: "swarm_wait" }],
        }),
        JSON.stringify({
          step_index: 17,
          type: "GENERIC",
          status: "DONE",
          created_at: "2026-11-25T13:19:19Z",
        }),
        JSON.stringify({
          step_index: 18,
          type: "GENERIC",
          status: "DONE",
          created_at: "2026-11-25T13:19:19Z",
        }),
      ].join("\n") + "\n",
    );
    members[w.name] = {
      conversation_id: w.cid,
      role: "worker",
      wake_mode: "mentions",
      killed: false,
    };
  }
  await writeFile(
    path.join(swarmDir, "members.json"),
    JSON.stringify({ title: "Wave 8+9", members }),
  );

  const roster = new Map<string, AgySubagentEntry>();
  await syncAgySubagentRoster(roster, coordId, brainDir);
  assert.equal(roster.size, 3, "batch-spawned workers sharing spawnStepIndex must not collide");

  const swarm = await readAgySwarmSnapshot(coordId, { brainDir });
  assert.ok(swarm);
  reconcileAgySubagentRosterWithSwarm(roster, swarm);
  for (const entry of roster.values()) {
    assert.equal(entry.status, "done");
  }

  // Subsequent poll must NOT overwrite existing done entries back to running before reconcile runs!
  await syncAgySubagentRoster(roster, coordId, brainDir);
  assert.equal(roster.size, 3);
  for (const entry of roster.values()) {
    assert.equal(entry.status, "done");
  }

  // When a swarm bar is present, live preview suppresses swarm workers while keeping non-swarm subagents.
  const workingSwarm = {
    ...swarm,
    members: swarm.members.map((m) =>
      m.name === "translator-8-2" ? { ...m, status: "working" as const } : m,
    ),
    workingCount: 1,
  };
  reconcileAgySubagentRosterWithSwarm(roster, workingSwarm);
  roster.set("boost-1", {
    key: "boost-1",
    name: "DeepInvestigator",
    typeName: "DeepInvestigator",
    tool: "invoke_subagent",
    status: "running",
    startedAtMs: Date.now() - 10_000,
    lastActivity: "step 4 · grep_search",
    messages: 0,
  });

  const previewWithoutExclusion = formatAgySubagentsLivePreviewLines(roster, Date.now());
  assert.equal(previewWithoutExclusion.length, 2);
  const previewWithSwarm = formatAgySubagentsLivePreviewLines(
    roster,
    Date.now(),
    undefined,
    workingSwarm,
  );
  assert.equal(previewWithSwarm.length, 1);
  assert.match(previewWithSwarm[0]!, /Agent\(DeepInvestigator\)/);
});

test("AgySwarmBoardDashboard reflects remapped Pi keybindings in footer hints", () => {
  const remappedKb = {
    matches: () => false,
    getKeys: (id: string) => {
      if (id === "tui.input.tab") return ["ctrl+n"];
      if (id === "tui.select.confirm") return ["ctrl+y"];
      if (id === "tui.select.cancel") return ["ctrl+g"];
      if (id === "tui.select.up") return ["up"];
      if (id === "tui.select.down") return ["down"];
      return [];
    },
  };
  const dash = new AgySwarmBoardDashboard(
    { terminal: { rows: 30, columns: 140 }, requestRender: () => {} } as any,
    plainTheme,
    remappedKb as any,
    {
      swarmId: "s-kb",
      coordinatorConversationId: "s-kb",
      dir: "/tmp/s-kb",
      title: "Keybinding Hint Check",
      members: [],
      posts: [],
      headSeq: 0,
      workingCount: 0,
      waitingCount: 0,
      stoppedCount: 0,
      killedCount: 0,
      failedCount: 0,
      done: false,
      newestUpdateMs: 0,
    },
    async () => undefined,
    () => {},
  );
  const rendered = dash.render(160).join("\n");
  assert.match(rendered, /ctrl\+n\/←→ pane/);
  assert.match(rendered, /ctrl\+y open/);
  assert.match(rendered, /ctrl\+g close/);
  dash.dispose();
});
