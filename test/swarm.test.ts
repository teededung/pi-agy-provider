import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgyPiBridge } from "../lib/bridge.ts";
import { ALL_FALLBACK_MODELS } from "../lib/models.ts";
import { formatAgyCall } from "../lib/render.ts";
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
  assert.match(initialOut, /Roster \(2\)/);
  assert.match(initialOut, /Posts \(2\)/);
  assert.match(initialOut, /Message #2 · @coder/);

  // Step to #1, zoom in, then unzoom and close.
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
