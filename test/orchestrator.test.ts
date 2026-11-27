import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { toProviderModel } from "../index.ts";
import { buildDriverAgyArgs, buildOneShotAgyArgs } from "../lib/agy-client.ts";
import { SwitchableAgyTurnExecutor, type AgyTurnExecutor } from "../lib/agy-driver.ts";
import { renderFooterLines, resolveAgyEffectiveContextLimit } from "../lib/footer.ts";
import {
  ALL_FALLBACK_MODELS,
  ORCHESTRATOR_EXECUTOR_BASES,
  ORCHESTRATOR_PLANNER_BASES,
  formatAgyOrchestratorBadge,
  getAgyConsultCompletions,
  isAgyOrchestratorModel,
  normalizeAgyOrchestratorConfig,
  resolveAgyConsultSpec,
  resolveOrchestratorRoleModel,
} from "../lib/models.ts";
import { newTurnOutcome } from "../lib/reducer.ts";
import {
  loadEffectiveAgyOrchestratorConfig,
  loadSavedAgyOrchestratorConfig,
  saveAgyOrchestratorConfig,
} from "../lib/tool-mode-settings.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Parameters<typeof renderFooterLines>[0]["theme"];

test("Orchestrator catalog, aliases, toProviderModel reasoning guard, and role resolution", () => {
  assert.equal(isAgyOrchestratorModel("gemini-pro-orchestrator-neon"), true);
  assert.equal(isAgyOrchestratorModel("gemini-pro-orchestrator"), true);
  assert.equal(isAgyOrchestratorModel("gemini-pro-orchestrator-argon"), true);
  assert.equal(isAgyOrchestratorModel("gemini-4-neon"), false);

  // Fallback catalog includes all 3 official Orchestrator presets.
  const ids = ALL_FALLBACK_MODELS.map((m) => m.id);
  assert.ok(ids.includes("gemini-pro-orchestrator-neon"));
  assert.ok(ids.includes("gemini-pro-orchestrator"));
  assert.ok(ids.includes("gemini-pro-orchestrator-argon"));

  // Official agy 1.5.18 orchestrator-model-roles families (4 planners, 2 executors).
  assert.deepEqual([...ORCHESTRATOR_PLANNER_BASES], [
    "gemini-4-neon",
    "gemini-4-carbon",
    "gemini-4-argon",
    "claude-opus-5-5",
  ]);
  assert.deepEqual([...ORCHESTRATOR_EXECUTOR_BASES], [
    "gemini-4-hydrogen",
    "claude-sonnet-5-5",
  ]);

  // Orchestrator models have no single global thought_level -> reasoning: false prevents no-op /thinking cycling.
  const orchProviderModel = toProviderModel({
    id: "gemini-pro-orchestrator-neon",
    name: "Orchestrator (Neon)",
    supportedEfforts: [],
  });
  assert.equal(orchProviderModel.reasoning, false);
  assert.equal(orchProviderModel.thinkingLevelMap, undefined);

  // Regular models retain reasoning: true and thinkingLevelMap.
  const neonProviderModel = toProviderModel({
    id: "gemini-4-neon",
    name: "Gemini 4 Neon",
    supportedEfforts: ["high", "xhigh", "medium", "low"],
    defaultEffort: "high",
  });
  assert.equal(neonProviderModel.reasoning, true);
  assert.equal(neonProviderModel.thinkingLevelMap?.xhigh, "xhigh");

  // /m orch alias resolves to Orchestrator (Neon) without fake effort digits in completions.
  const spec = resolveAgyConsultSpec("orch audit this diff");
  assert.equal(spec.ok, true);
  if (spec.ok) {
    assert.equal(spec.model.id, "gemini-pro-orchestrator-neon");
    assert.equal(spec.effort, undefined);
    assert.equal(spec.prompt, "audit this diff");
  }
  const completions = getAgyConsultCompletions("orch") ?? [];
  assert.deepEqual(
    completions.map((c) => c.label),
    ["orch"],
  );

  // Role shorthand parsing + badge formatting.
  assert.equal(resolveOrchestratorRoleModel("planner", "neon4"), "gemini-4-neon-xhigh");
  assert.equal(resolveOrchestratorRoleModel("planner", "opus3"), "claude-opus-5-5-high");
  assert.equal(resolveOrchestratorRoleModel("planner", "gemini-4-carbon-high"), "gemini-4-carbon-high");
  assert.equal(resolveOrchestratorRoleModel("executor", "hydrogen2"), "gemini-4-hydrogen-medium");
  assert.equal(resolveOrchestratorRoleModel("executor", "sonnet3"), "claude-sonnet-5-5-high");
  // Reject models outside the role's eligible family (unless full model ID explicitly matches an eligible base).
  assert.equal(resolveOrchestratorRoleModel("executor", "opus3"), undefined);

  assert.deepEqual(
    normalizeAgyOrchestratorConfig({
      planner: " gemini-4-neon-xhigh ",
      executor: "gemini-4-hydrogen-medium",
    }),
    { planner: "gemini-4-neon-xhigh", executor: "gemini-4-hydrogen-medium" },
  );
  assert.equal(normalizeAgyOrchestratorConfig({ planner: "  ", executor: "" }), undefined);

  assert.equal(
    formatAgyOrchestratorBadge({
      planner: "gemini-4-neon-xhigh",
      executor: "gemini-4-hydrogen-medium",
    }),
    "neon-xhigh → hydrogen-med",
  );
  assert.equal(
    formatAgyOrchestratorBadge({
      planner: "claude-opus-5-5-high",
      executor: "claude-sonnet-5-5-high",
    }),
    "opus-high → sonnet-high",
  );
});

test("Orchestrator settings persist in Pi settings.json and fall back to native agy settings.json", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-orch-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const piFile = path.join(dir, "pi-settings.json");
  const agyFile = path.join(dir, "agy-settings.json");

  await writeFile(piFile, JSON.stringify({ antigravity: { driver: "acp" } }));
  await writeFile(
    agyFile,
    JSON.stringify({
      orchestrator: {
        planner: "claude-opus-5-5-high",
        executor: "gemini-4-hydrogen-high",
      },
    }),
  );

  // Without Pi override, falls back cleanly to native agy settings.json.
  assert.equal(loadSavedAgyOrchestratorConfig(piFile), undefined);
  assert.deepEqual(loadEffectiveAgyOrchestratorConfig(piFile, agyFile), {
    config: { planner: "claude-opus-5-5-high", executor: "gemini-4-hydrogen-high" },
    source: "agy",
  });

  // Saving Pi override wins over native agy settings without clobbering other antigravity keys.
  await saveAgyOrchestratorConfig(
    { planner: "gemini-4-neon-xhigh", executor: "gemini-4-hydrogen-medium" },
    piFile,
  );
  assert.deepEqual(loadSavedAgyOrchestratorConfig(piFile), {
    planner: "gemini-4-neon-xhigh",
    executor: "gemini-4-hydrogen-medium",
  });
  assert.deepEqual(loadEffectiveAgyOrchestratorConfig(piFile, agyFile), {
    config: { planner: "gemini-4-neon-xhigh", executor: "gemini-4-hydrogen-medium" },
    source: "pi",
  });
  const savedDoc = JSON.parse(await readFile(piFile, "utf8"));
  assert.equal(savedDoc.antigravity.driver, "acp");

  // Saving undefined removes antigravity.orchestrator cleanly.
  await saveAgyOrchestratorConfig(undefined, piFile);
  assert.equal(loadSavedAgyOrchestratorConfig(piFile), undefined);
  const clearedDoc = JSON.parse(await readFile(piFile, "utf8"));
  assert.equal("orchestrator" in clearedDoc.antigravity, false);
  assert.equal(clearedDoc.antigravity.driver, "acp");
});

test("CLI args inject --settings orchestrator cleanly and merge with read-only permissions", () => {
  const driverArgs = buildDriverAgyArgs({
    model: "gemini-pro-orchestrator-neon",
    orchestrator: {
      planner: "gemini-4-neon-xhigh",
      executor: "gemini-4-hydrogen-medium",
    },
  });
  assert.ok(driverArgs.includes("--dangerously-skip-permissions"));
  const settingsIdx = driverArgs.indexOf("--settings");
  assert.ok(settingsIdx >= 0, "must pass --settings when orchestrator config is set");
  assert.deepEqual(JSON.parse(driverArgs[settingsIdx + 1]!), {
    orchestrator: {
      planner: "gemini-4-neon-xhigh",
      executor: "gemini-4-hydrogen-medium",
    },
  });

  // Read-only permissions merges orchestrator into the same --settings JSON object.
  const roArgs = buildOneShotAgyArgs({
    prompt: "summarize",
    model: "gemini-pro-orchestrator-neon",
    readOnlyPermissions: true,
    orchestrator: {
      planner: "claude-opus-5-5-high",
      executor: "claude-sonnet-5-5-medium",
    },
  });
  assert.equal(roArgs.includes("--dangerously-skip-permissions"), false);
  const roSettingsIdx = roArgs.indexOf("--settings");
  assert.ok(roSettingsIdx >= 0);
  const parsedRo = JSON.parse(roArgs[roSettingsIdx + 1]!);
  assert.equal(parsedRo.toolPermission, "strict");
  assert.deepEqual(parsedRo.orchestrator, {
    planner: "claude-opus-5-5-high",
    executor: "claude-sonnet-5-5-medium",
  });

  // Normal non-orchestrator turn omits --settings.
  const normalArgs = buildDriverAgyArgs({ model: "gemini-4-neon", effort: "high" });
  assert.equal(normalArgs.includes("--settings"), false);
});

test("SwitchableAgyTurnExecutor delegates custom Orchestrator turns to stream-json when in acp mode", async () => {
  const acpCalls: string[] = [];
  const streamCalls: Array<{ model?: string; orchestrator?: unknown }> = [];
  let streamClosed = false;

  const fakeAcp: AgyTurnExecutor = {
    supportsNativeImages: true,
    async run(req) {
      acpCalls.push(req.model ?? "");
      return newTurnOutcome();
    },
    snapshot: () => ({ mode: "acp", state: "ready", lifecycle: [] }),
    async close() {},
  };
  const fakeStream: AgyTurnExecutor = {
    async run(req) {
      streamCalls.push({ model: req.model, orchestrator: req.orchestrator });
      return newTurnOutcome();
    },
    snapshot: () => ({ mode: "persistent", state: "ready", lifecycle: [] }),
    async close() {
      streamClosed = true;
    },
  };

  const switcher = new SwitchableAgyTurnExecutor("acp", {
    createExecutor: (mode) => (mode === "acp" ? fakeAcp : fakeStream),
  });

  // Regular turn uses ACP.
  await switcher.run({ prompt: "hi", model: "gemini-4-neon" });
  assert.deepEqual(acpCalls, ["gemini-4-neon"]);
  assert.equal(streamCalls.length, 0);

  // Custom Orchestrator turn delegates cleanly to stream-json so --settings orchestrator takes effect.
  await switcher.run({
    prompt: "plan and execute",
    model: "gemini-pro-orchestrator-neon",
    orchestrator: { planner: "gemini-4-neon-xhigh", executor: "gemini-4-hydrogen-medium" },
  });
  assert.equal(acpCalls.length, 1);
  assert.deepEqual(streamCalls, [
    {
      model: "gemini-pro-orchestrator-neon",
      orchestrator: { planner: "gemini-4-neon-xhigh", executor: "gemini-4-hydrogen-medium" },
    },
  ]);

  await switcher.close("shutdown");
  assert.equal(streamClosed, true);
});

test("Footer displays Orchestrator Planner -> Executor badge and uses planner context window", () => {
  assert.equal(
    resolveAgyEffectiveContextLimit("gemini-pro-orchestrator-neon", {}, { planner: "claude-opus-5-5-high" }),
    1_000_000,
  );
  assert.equal(
    resolveAgyEffectiveContextLimit("gemini-pro-orchestrator-neon", {}, { planner: "gemini-4-neon-xhigh" }),
    512_000,
  );

  const lines = renderFooterLines({
    width: 120,
    cwd: "/tmp/proj",
    provider: "antigravity",
    modelId: "gemini-pro-orchestrator-neon",
    reasoning: false,
    thinkingLevel: "high",
    orchestratorBadge: "neon-xhigh → hydrogen-med",
    orchestratorPlannerModelId: "claude-opus-5-5-high",
    availableProviderCount: 2,
    agyContextTokens: 100_000,
    usageTotals: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    theme: plainTheme,
  });
  assert.match(lines[0]!, /gemini-pro-orchestrator-neon • neon-xhigh → hydrogen-med/);
  assert.doesNotMatch(lines[0]!, /• high/);
  assert.match(lines[1]!, /~100k\/1\.0M/);
});
