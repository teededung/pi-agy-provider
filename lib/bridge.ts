/**
 * AgyPiBridge — loopback MCP server (streamable HTTP) exposing active pi
 * tools to agy as `pi__<name>`, plus the pending-call store that correlates
 * agy's MCP calls with pi tool executions.
 *
 * Call flow (mirrors the replay flow, but executing):
 *   1. agy calls `pi__<tool>` → our HTTP handler enqueues a pending call and
 *      notifies the runtime (`onCall`), which pushes a synthetic
 *      `bridge_call` activity into the live AgyTurnController;
 *   2. the provider ends the pi turn with stopReason "toolUse" for the REAL
 *      pi tool (native cards, hooks, permissions, abort);
 *   3. pi executes the tool; the toolResult lands in context;
 *   4. the next streamAntigravity request re-attaches to the running agy
 *      turn, matches the toolResult by toolCallId, resolves the HTTP
 *      response, and agy continues in the same conversation.
 *
 * The handler never resolves directly from the HTTP side: it blocks until
 * the provider hands back the executed result, or times out (fail closed).
 */

import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ImageContent, JsonObject, TextContent } from "@earendil-works/pi-ai";
import { WRAPPER_TOOL_NAME } from "./prompt.ts";
import type { AgyToolMode } from "./tool-mode.ts";

export const BRIDGE_SERVER_NAME = "pi-bridge";
export const BRIDGE_TOOL_PREFIX = "pi__";
/** Per-call cap; must stay below agy's 600s turn timeout so agy can still report the failure. */
export const BRIDGE_CALL_TIMEOUT_MS = 480_000;
export const DEFAULT_BRIDGE_PROGRESS_KEEPALIVE_MS = 15_000;

export interface BridgeToolDef {
  /** Real pi tool name (without the `pi__` prefix). */
  name: string;
  description: string;
  /** JSON schema (typebox) for the tool parameters. */
  parameters: unknown;
}

/** Shape of pi's ToolInfo the bridge selection needs. */
export interface PiToolInfo {
  name: string;
  description?: string;
  parameters?: unknown;
  sourceInfo?: { source?: string; path?: string };
  exposure?: string;
}

/**
 * Native mode exposes active tools registered by Pi's built-in MCP extension
 * (`builtin:mcp`), with skills bridged separately as `pi__activate_skill`.
 * Pi tool mode instead exposes every active Pi builtin, extension and MCP
 * tool. Calls execute as real model tool calls in Pi, so its active tool set,
 * hooks and permissions apply. Inactive and hidden tools and the display-only
 * replay wrapper are never exposed; codemode can reach its own callable tools.
 */
const BUILTIN_MCP_PATH = "builtin:mcp";

/** Native mode bridges built-in MCP tools; Pi mode bridges the active Pi tool set. */
export function selectBridgedTools(
  tools: PiToolInfo[],
  activeNames: readonly string[],
  mode: AgyToolMode = "native",
): BridgeToolDef[] {
  const active = new Set(activeNames);
  const bridged: BridgeToolDef[] = [];
  for (const tool of tools) {
    if (!active.has(tool.name) || tool.exposure === "hidden") continue;
    if (tool.name === WRAPPER_TOOL_NAME) continue; // display-only replay wrapper
    if (mode === "native" && tool.sourceInfo?.path !== BUILTIN_MCP_PATH) continue;
    bridged.push({
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters,
    });
  }
  return bridged;
}

export interface BridgeCallResult {
  /** Strings are convenient for local diagnostics and dynamic skill tools. */
  content: string | Array<TextContent | ImageContent>;
  isError: boolean;
}

export interface BridgeCall {
  id: string;
  tool: string;
  args: JsonObject;
}

type PendingCall = BridgeCall & {
  resolve: (result: BridgeCallResult) => void;
  timer: NodeJS.Timeout;
};

/** A dynamically-refreshed virtual tool (one per bridged pi skill). */
interface DynamicTool {
  description: string;
  parameters: unknown;
  handler: (args: JsonObject) => Promise<BridgeCallResult>;
}

interface JsonRpcRequest {
  id?: number | string | null;
  method?: string;
  params?: {
    protocolVersion?: string;
    name?: string;
    arguments?: JsonObject;
    _meta?: {
      progressToken?: string | number;
    };
  };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, canonicalValue(object[key])]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export class AgyPiBridge {
  #tools: BridgeToolDef[] = [];
  #server: Server | undefined;
  #port = 0;
  #seq = 0;
  #pending = new Map<string, PendingCall>();
  /** Shared secret agy must send on every request; unset = no auth (tests). */
  #token: string | undefined;
  /** Unique descriptor-cache key; each agy process discovers its own private server. */
  readonly serverName: string;
  /** Callback that routes a call into the live agy turn controller. Returns false when no turn is active. */
  #onCall: ((call: BridgeCall) => boolean) | undefined;
  /** Source of the current active-tool snapshot, invoked once per provider request. */
  #toolSource: (() => BridgeToolDef[]) | undefined;
  /** Replaced wholesale on every skills refresh (activate_skill, or empty). */
  #dynamic = new Map<string, DynamicTool>();
  #catalogDigest = createHash("sha256").update("[]").digest("hex");
  #catalogRevision = 0;
  readonly #progressKeepaliveMs: number;

  constructor(
    serverName: string = BRIDGE_SERVER_NAME,
    options?: { progressKeepaliveMs?: number },
  ) {
    this.serverName = serverName;
    this.#progressKeepaliveMs = Math.max(
      10,
      options?.progressKeepaliveMs ?? DEFAULT_BRIDGE_PROGRESS_KEEPALIVE_MS,
    );
  }

  /** Require `token` in the x-pi-bridge-token header on every request. */
  requireToken(token: string): void {
    this.#token = token;
  }

  setOnCall(onCall: (call: BridgeCall) => boolean): void {
    this.#onCall = onCall;
  }

  setToolSource(toolSource: () => BridgeToolDef[]): void {
    this.#toolSource = toolSource;
  }

  /** Refresh the exposed-tool snapshot and report whether canonical content changed. */
  refreshTools(): boolean {
    this.#tools = this.#toolSource?.() ?? [];
    return this.#updateCatalogRevision();
  }

  /** True when `name` (unprefixed Pi tool name) is currently exposed on the bridge. */
  hasTool(name: string): boolean {
    return this.#tools.some((tool) => tool.name === name) || this.#dynamic.has(name);
  }

  /** Return the JSON schema parameters for a bridged tool, if known. */
  getToolParameters(name: string): unknown {
    return (
      this.#dynamic.get(name)?.parameters ??
      this.#tools.find((tool) => tool.name === name)?.parameters
    );
  }

  get catalogRevision(): number {
    return this.#catalogRevision;
  }

  /**
   * Replace the dynamic tool set (used for `pi__activate_skill`, handled
   * in-process without a pi toolUse round-trip). The whole set is swapped
   * so a missing catalog disappears from tools/list on the next refresh.
   */
  setDynamicTools(
    tools: Array<{
      name: string;
      description: string;
      parameters: unknown;
      handler: (args: JsonObject) => Promise<BridgeCallResult>;
    }>,
  ): void {
    this.#dynamic = new Map(tools.map((tool) => [tool.name, { ...tool }]));
    this.#updateCatalogRevision();
  }

  #updateCatalogRevision(): boolean {
    const catalog = [
      ...this.#tools
        .filter((tool) => !this.#dynamic.has(tool.name))
        .map((tool) => ({
          name: `${BRIDGE_TOOL_PREFIX}${tool.name}`,
          description:
            tool.description || `pi tool "${tool.name}" bridged into agy by ${BRIDGE_SERVER_NAME}.`,
          inputSchema: tool.parameters,
        })),
      ...[...this.#dynamic].map(([name, definition]) => ({
        name: `${BRIDGE_TOOL_PREFIX}${name}`,
        description: definition.description,
        inputSchema: definition.parameters,
      })),
    ].sort((a, b) => a.name.localeCompare(b.name));
    const digest = createHash("sha256").update(canonicalJson(catalog)).digest("hex");
    if (digest === this.#catalogDigest) return false;
    this.#catalogDigest = digest;
    this.#catalogRevision += 1;
    return true;
  }

  get url(): string | undefined {
    return this.#server ? `http://127.0.0.1:${this.#port}/mcp` : undefined;
  }

  get running(): boolean {
    return this.#server !== undefined;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  start(): Promise<void> {
    if (this.#server) return Promise.resolve();
    const server = createServer((req, res) => this.#handleHttp(req, res));
    server.maxConnections = 64;
    this.#server = server;
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        // A failed listen must not leave the bridge marked as running.
        this.#server = undefined;
        reject(error);
      };
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        const addr = server.address();
        if (addr && typeof addr === "object") this.#port = addr.port;
        resolve();
      });
    });
  }

  /** Fail all pending calls and stop listening, closing keep-alive sockets immediately. */
  close(): Promise<void> {
    const server = this.#server;
    if (!server) return Promise.resolve();
    this.#server = undefined;
    this.#port = 0;
    this.cancelPendingCalls("antigravity: pi session shut down while the tool call was pending.");
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  /** Cancel any in-flight Pi tool calls when the upstream Antigravity turn exits early. */
  cancelPendingCalls(
    reason = "antigravity: turn ended before pi returned the tool result.",
  ): number {
    if (this.#pending.size === 0) return 0;
    let count = 0;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ content: reason, isError: true });
      count += 1;
    }
    this.#pending.clear();
    return count;
  }

  /** True when the provider is still waiting for pi to execute this call. */
  isAwaiting(callId: string): boolean {
    return this.#pending.has(callId);
  }

  /** Hand the executed pi tool result back to the waiting agy MCP call. */
  resolveCall(callId: string, result: BridgeCallResult): boolean {
    const pending = this.#pending.get(callId);
    if (!pending) return false;
    this.#pending.delete(callId);
    clearTimeout(pending.timer);
    pending.resolve(result);
    return true;
  }

  // --- HTTP / JSON-RPC -----------------------------------------------------

  #handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (this.#token !== undefined && req.headers["x-pi-bridge-token"] !== this.#token) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden" } }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "GET not supported" } }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let rpc: JsonRpcRequest;
      try {
        rpc = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as JsonRpcRequest;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }),
        );
        return;
      }
      const acceptHeader = Array.isArray(req.headers.accept)
        ? req.headers.accept.join(",")
        : (req.headers.accept ?? "");
      const progressToken = rpc.params?._meta?.progressToken;
      const useSseProgress =
        rpc.method === "tools/call" &&
        acceptHeader.includes("text/event-stream") &&
        (typeof progressToken === "string" || typeof progressToken === "number");

      if (useSseProgress) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "mcp-session-id": SESSION_ID,
        });
        let progress = 0;
        let keepalive: NodeJS.Timeout | undefined;
        const stopKeepalive = () => {
          if (!keepalive) return;
          clearInterval(keepalive);
          keepalive = undefined;
        };
        const sendProgress = () => {
          if (res.writableEnded || res.destroyed) {
            stopKeepalive();
            return;
          }
          const frame = {
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: {
              progressToken,
              progress: progress++,
              message: "Waiting for Pi tool execution",
            },
          };
          res.write(`event: message\ndata: ${JSON.stringify(frame)}\n\n`);
        };
        res.once("close", stopKeepalive);
        sendProgress();
        keepalive = setInterval(sendProgress, this.#progressKeepaliveMs);
        keepalive.unref?.();

        void this.#handleRpc(rpc)
          .then(
            (response) => {
              stopKeepalive();
              if (res.writableEnded || res.destroyed) return;
              if (response) {
                res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
              }
              res.end();
            },
            () => {
              stopKeepalive();
              if (res.writableEnded || res.destroyed) return;
              const errFrame = {
                jsonrpc: "2.0",
                id: rpc.id ?? null,
                error: { code: -32603, message: "Internal error" },
              };
              res.write(`event: message\ndata: ${JSON.stringify(errFrame)}\n\n`);
              res.end();
            },
          )
          .finally(() => {
            res.off("close", stopKeepalive);
            stopKeepalive();
          });
        return;
      }

      void this.#handleRpc(rpc).then(
        (response) => {
          if (!response) {
            // Notification: no body per the streamable HTTP spec.
            res.writeHead(202);
            res.end();
            return;
          }
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": SESSION_ID,
          });
          res.end(JSON.stringify(response));
        },
        () => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" } }),
          );
        },
      );
    });
  }

  async #handleRpc(rpc: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
    const base = { jsonrpc: "2.0", id: rpc.id ?? null };
    switch (rpc.method) {
      case "initialize": {
        return {
          ...base,
          result: {
            protocolVersion: rpc.params?.protocolVersion ?? "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: this.serverName, version: "1.0.0" },
          },
        };
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined; // notification — 202, no body
      case "tools/list": {
        return {
          ...base,
          result: {
            tools: [
              ...this.#tools
                .filter((tool) => !this.#dynamic.has(tool.name))
                .map((tool) => ({
                  name: `${BRIDGE_TOOL_PREFIX}${tool.name}`,
                  description:
                    tool.description ||
                    `pi tool "${tool.name}" bridged into agy by ${BRIDGE_SERVER_NAME}.`,
                  inputSchema: tool.parameters,
                })),
              ...[...this.#dynamic].map(([name, definition]) => ({
                name: `${BRIDGE_TOOL_PREFIX}${name}`,
                description: definition.description,
                inputSchema: definition.parameters,
              })),
            ],
          },
        };
      }
      case "tools/call": {
        const name = rpc.params?.name ?? "";
        const args = rpc.params?.arguments ?? {};
        const result = await this.#routeCall(name, args);
        return {
          ...base,
          result: {
            content:
              typeof result.content === "string"
                ? [{ type: "text", text: result.content }]
                : result.content,
            isError: result.isError,
          },
        };
      }
      default:
        return {
          ...base,
          error: { code: -32601, message: `Method not found: ${rpc.method}` },
        };
    }
  }

  /**
   * Route one `pi__<tool>` invocation into the live agy turn and wait for pi
   * to execute it. Fails closed: no active turn, unknown tool, or timeout
   * all produce an isError result rather than hanging agy.
   */
  async #routeCall(mcpName: string, args: JsonObject): Promise<BridgeCallResult> {
    if (!mcpName.startsWith(BRIDGE_TOOL_PREFIX)) {
      return {
        content: `antigravity: unknown tool "${mcpName}" — only ${BRIDGE_TOOL_PREFIX}* bridge tools exist.`,
        isError: true,
      };
    }
    const tool = mcpName.slice(BRIDGE_TOOL_PREFIX.length);
    const dynamic = this.#dynamic.get(tool);
    if (dynamic) return dynamic.handler(args);
    if (this.#tools.some((def) => def.name === tool)) {
      return this.#routeToPiTool(tool, args);
    }
    return { content: `antigravity: tool "${tool}" is not currently active in pi.`, isError: true };
  }

  async #routeToPiTool(tool: string, args: JsonObject): Promise<BridgeCallResult> {
    const id = `pi-bridge-${++this.#seq}`;
    const dispatched = this.#onCall?.({ id, tool, args }) ?? false;
    if (!dispatched) {
      return {
        content: "antigravity: no active agy turn to route the tool call into.",
        isError: true,
      };
    }
    return new Promise<BridgeCallResult>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({
          content: `antigravity: pi tool "${tool}" did not return within ${Math.round(BRIDGE_CALL_TIMEOUT_MS / 1000)}s.`,
          isError: true,
        });
      }, BRIDGE_CALL_TIMEOUT_MS);
      timer.unref?.();
      const pending: PendingCall = {
        id,
        tool,
        args,
        resolve,
        timer,
      };
      this.#pending.set(id, pending);
    });
  }
}

const SESSION_ID = randomUUID();

/** Extract bridge-awaiting tool results from a pi context and resolve them. */
export function resolveBridgeResultsFromContext(
  bridge: AgyPiBridge,
  messages: readonly unknown[],
): number {
  let resolved = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as {
      role?: string;
      toolCallId?: string;
      isError?: boolean;
      content?: Array<TextContent | ImageContent>;
    };
    if (message?.role !== "toolResult" || !message.toolCallId) continue;
    if (!bridge.isAwaiting(message.toolCallId)) continue;
    bridge.resolveCall(message.toolCallId, {
      content: message.content ?? [],
      isError: message.isError === true,
    });
    resolved += 1;
  }
  return resolved;
}
