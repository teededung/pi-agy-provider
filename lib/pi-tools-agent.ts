import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { PI_TOOLS_AGENT_DESCRIPTION, piToolsAgentPrompt } from "./prompt.ts";

/** Core Pi tools marked eager so agy registers them as direct native tool declarations without lazy schema reads. */
export const EAGER_PI_BRIDGE_TOOLS = [
  "pi__read",
  "pi__bash",
  "pi__edit",
  "pi__write",
  "pi__ask_user_question",
  "pi__grep",
  "pi__find",
  "pi__ls",
  "pi__web_search",
  "pi__fetch_content",
  "pi__get_search_content",
  "pi__source_check",
  "pi__x_search",
  "pi__codemode",
] as const;

/**
 * Antigravity-exclusive native tools kept available alongside bridged Pi tools
 * so models retain native image viewing (`view_file`, avoiding ACP MCP image
 * offloading), image generation, and built-in web fallback when Pi web
 * extensions are not installed.
 *
 * Note: In `agy 1.5.0+`, `"view_file"` already resolves to the built-in
 * `read_file` declaration; listing both `"read_file"` and `"view_file"` fails
 * executor construction with a duplicate `"read_file"` tool conflict.
 */
export const PI_TOOLS_AGENT_NATIVE_TOOLS = [
  "view_file",
  "generate_image",
  "search_web",
  "read_url_content",
] as const;

export const EAGER_PI_BRIDGE_TOOLS_CONFIG: Record<string, { eager: true }> = Object.fromEntries(
  EAGER_PI_BRIDGE_TOOLS.map((toolName) => [toolName, { eager: true as const }]),
);

export interface PiToolsAgentBridge {
  serverName: string;
  url: string;
  token: string;
}

/** One session-owned agent, discovered by agy without changing the workspace. */
export function createPiToolsAgent(
  agentRoot = path.join(homedir(), ".gemini", "config", "agents"),
) {
  const name = `pi-tools-${process.pid}-${randomUUID()}`;
  const directory = path.join(agentRoot, name);
  let prepared = false;

  return {
    name,
    isPrepared: () => prepared,
    async prepare(bridge: PiToolsAgentBridge): Promise<void> {
      prepared = false;
      const definition = {
        name,
        description: PI_TOOLS_AGENT_DESCRIPTION,
        mainAgent: true,
        subagent: false,
        inheritCustomizations: false,
        tools: [...PI_TOOLS_AGENT_NATIVE_TOOLS],
        mcpServers: [
          {
            name: bridge.serverName,
            url: bridge.url,
            serverUrl: bridge.url,
            headers: { "x-pi-bridge-token": bridge.token },
            tools: EAGER_PI_BRIDGE_TOOLS_CONFIG,
          },
        ],
      };
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // JSON is valid YAML frontmatter and safely quotes the URL, name and token.
      await writeFile(
        path.join(directory, "agent.md"),
        `---
${JSON.stringify(definition, null, 2)}
---

${piToolsAgentPrompt(bridge.serverName)}
`,
        { mode: 0o600 },
      );
      prepared = true;
    },
    async remove(): Promise<void> {
      prepared = false;
      await rm(directory, { recursive: true, force: true });
    },
    removeSync(): void {
      prepared = false;
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup on process exit.
      }
    },
  };
}

/** Static schema-enforced read-only agent for `/btw:ask` (no edit/write/shell tools declared). */
export const PI_READ_ONLY_AGENT_NAME = "pi-agy-readonly";
/** Static zero-tool agent for `/compact` and `/btw:summarize` (pure text summarization). */
export const PI_NO_TOOLS_AGENT_NAME = "pi-agy-notools";

export const PI_READ_ONLY_AGENT_TOOLS = [
  "view_file",
  "grep_search",
  "find_by_name",
  "list_dir",
  "search_web",
  "read_url_content",
] as const;

export function isSchemaReadOnlyAgyAgent(agent?: string): boolean {
  return agent === PI_READ_ONLY_AGENT_NAME || agent === PI_NO_TOOLS_AGENT_NAME;
}

/**
 * Materialize a static read-only (or zero-tool) custom `agy` agent definition.
 * Because the file contains no session-specific secrets or ports, concurrent Pi
 * sessions share it safely and atomic write+rename prevents partial reads.
 * Returns the agent name on success, or `undefined` if writing fails so callers
 * can fall back to `READ_ONLY_AGY_SETTINGS_JSON`.
 */
export async function ensureReadOnlyAgyAgent(
  kind: "readonly" | "notools",
  agentRoot = path.join(homedir(), ".gemini", "config", "agents"),
): Promise<string | undefined> {
  const name = kind === "notools" ? PI_NO_TOOLS_AGENT_NAME : PI_READ_ONLY_AGENT_NAME;
  const definition = {
    name,
    description:
      kind === "notools"
        ? "Text-only summarization assistant for Pi compaction and aside summaries."
        : "Read-only side-question assistant for Pi /btw:ask (file reading and web lookup only).",
    mainAgent: true,
    subagent: false,
    inheritCustomizations: false,
    tools: kind === "notools" ? [] : [...PI_READ_ONLY_AGENT_TOOLS],
  };
  const body =
    kind === "notools"
      ? "Answer or summarize the provided context directly as plain text without calling tools."
      : "Answer read-only side questions directly using only the declared read/search tools. Never attempt to modify files or run shell commands.";
  const content = `---\n${JSON.stringify(definition, null, 2)}\n---\n\n${body}\n`;
  const dir = path.join(agentRoot, name);
  const target = path.join(dir, "agent.md");
  try {
    try {
      if ((await readFile(target, "utf8")) === content) return name;
    } catch {
      // Missing or unreadable — write fresh below.
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.agent.md.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, content, { mode: 0o600 });
    await rename(tmp, target);
    return name;
  } catch {
    return undefined;
  }
}
