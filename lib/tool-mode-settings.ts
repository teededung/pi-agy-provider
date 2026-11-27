import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { normalizeAgyDriverMode, type AgyDriverMode } from "./agy-driver.ts";
import type { AgyFooterMode } from "./footer.ts";
import { normalizeAgyOrchestratorConfig, type AgyOrchestratorConfig } from "./models.ts";
import type { AgyToolMode } from "./tool-mode.ts";

function settingsPath(): string {
  return path.join(getAgentDir(), "settings.json");
}

function nativeAgySettingsPath(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDocument(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const document: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!isRecord(document)) throw new Error("Pi settings.json must contain an object.");
  if (document.antigravity !== undefined && !isRecord(document.antigravity)) {
    throw new Error("Pi settings antigravity must contain an object.");
  }
  return document;
}

/** Read the user preference; CLI and environment overrides are resolved separately. */
export function loadSavedAgyToolMode(file = settingsPath()): AgyToolMode | undefined {
  const settings = readDocument(file).antigravity as Record<string, unknown> | undefined;
  const mode = settings?.toolMode;
  if (mode === undefined) return undefined;
  if (mode !== "native" && mode !== "pi") {
    throw new Error('Pi settings antigravity.toolMode must be exactly "native" or "pi".');
  }
  return mode;
}

/** Read the saved 2-row custom footer preference ("on" | "off"). */
export function loadSavedAgyFooterMode(file = settingsPath()): AgyFooterMode | undefined {
  const settings = readDocument(file).antigravity as Record<string, unknown> | undefined;
  const mode = settings?.footer;
  if (mode === undefined) return undefined;
  if (mode === "on" || mode === true) return "on";
  if (mode === "off" || mode === false) return "off";
  throw new Error('Pi settings antigravity.footer must be exactly "on" or "off".');
}

/** Read the saved driver mode ("acp" | "stream-json" | "one-shot"). */
export function loadSavedAgyDriverMode(file = settingsPath()): AgyDriverMode | undefined {
  const document = readDocument(file);
  const piAgy = isRecord(document["pi-agy"]) ? document["pi-agy"] : undefined;
  const antigravity = document.antigravity as Record<string, unknown> | undefined;
  const raw = piAgy?.driver ?? antigravity?.driver;
  if (raw === undefined) return undefined;
  const mode = normalizeAgyDriverMode(raw);
  if (!mode) {
    throw new Error(
      'Pi settings driver must be one of "acp", "stream-json", "persistent", "legacy", or "one-shot".',
    );
  }
  return mode;
}

/** Read saved Pi Orchestrator Planner/Executor overrides under antigravity.orchestrator. */
export function loadSavedAgyOrchestratorConfig(
  file = settingsPath(),
): AgyOrchestratorConfig | undefined {
  const settings = readDocument(file).antigravity as Record<string, unknown> | undefined;
  const raw = settings?.orchestrator;
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new Error("Pi settings antigravity.orchestrator must contain an object.");
  }
  return normalizeAgyOrchestratorConfig(raw);
}

/** Best-effort read of native agy `~/.gemini/antigravity-cli/settings.json` `"orchestrator"`. */
export function loadNativeAgyOrchestratorConfig(
  file = nativeAgySettingsPath(),
): AgyOrchestratorConfig | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (!isRecord(parsed)) return undefined;
    return normalizeAgyOrchestratorConfig(parsed.orchestrator);
  } catch {
    return undefined;
  }
}

/** Resolve effective Orchestrator Planner/Executor config (Pi override wins, else native agy settings). */
export function loadEffectiveAgyOrchestratorConfig(
  piFile = settingsPath(),
  agyFile = nativeAgySettingsPath(),
): { config?: AgyOrchestratorConfig; source: "pi" | "agy" | "default" } {
  try {
    const saved = loadSavedAgyOrchestratorConfig(piFile);
    if (saved) return { config: saved, source: "pi" };
  } catch {
    // Fall through to native agy settings on malformed Pi settings.
  }
  const native = loadNativeAgyOrchestratorConfig(agyFile);
  if (native) return { config: native, source: "agy" };
  return { source: "default" };
}

async function saveAntigravitySetting(
  key: "toolMode" | "footer" | "driver" | "orchestrator",
  value: unknown,
  file = settingsPath(),
): Promise<void> {
  await withFileMutationQueue(file, async () => {
    mkdirSync(path.dirname(file), { recursive: true });
    const release = lockfile.lockSync(file, { realpath: false });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const document = readDocument(file);
      const nextAntigravity: Record<string, unknown> = {
        ...(document.antigravity as Record<string, unknown> | undefined),
      };
      if (value === undefined) {
        delete nextAntigravity[key];
      } else {
        nextAntigravity[key] = value;
      }
      document.antigravity = nextAntigravity;
      if (key === "driver" && isRecord(document["pi-agy"]) && "driver" in document["pi-agy"]) {
        const nextPiAgy = { ...document["pi-agy"] };
        delete nextPiAgy.driver;
        document["pi-agy"] = nextPiAgy;
      }
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporary, file);
    } finally {
      try {
        rmSync(temporary, { force: true });
      } finally {
        release();
      }
    }
  });
}

/** Merge under the same file lock Pi uses, preserving other sessions' settings. */
export async function saveAgyToolMode(mode: AgyToolMode, file = settingsPath()): Promise<void> {
  await saveAntigravitySetting("toolMode", mode, file);
}

/** Persist the custom footer preference ("on" | "off") under antigravity.footer. */
export async function saveAgyFooterMode(mode: AgyFooterMode, file = settingsPath()): Promise<void> {
  await saveAntigravitySetting("footer", mode, file);
}

/** Persist the driver preference ("acp" | "stream-json" | "one-shot") under antigravity.driver. */
export async function saveAgyDriverMode(mode: AgyDriverMode, file = settingsPath()): Promise<void> {
  await saveAntigravitySetting("driver", mode, file);
}

/** Persist (or clear when undefined) custom Orchestrator Planner/Executor overrides under antigravity.orchestrator. */
export async function saveAgyOrchestratorConfig(
  config: AgyOrchestratorConfig | undefined,
  file = settingsPath(),
): Promise<void> {
  await saveAntigravitySetting("orchestrator", normalizeAgyOrchestratorConfig(config), file);
}
