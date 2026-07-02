import { spawn } from "node:child_process";
import type { McpStdioServerConfig } from "./config";
import {
  McpClosedError,
  McpHandshakeError,
  McpMalformedResponseError,
  McpRpcError,
  McpServerCrashError,
  McpTimeoutError,
  type McpTransportError,
} from "./errors";
import { createFrameParser, encodeFrame } from "./framing";

/**
 * The MCP stdio transport (plan 23 M2): spawns a configured server as a child process and
 * speaks JSON-RPC 2.0 over Content-Length-framed pipes - the initialize handshake with
 * protocolVersion negotiation, request/response correlation by id, per-request timeouts,
 * pending-request draining on every death path (crash, close, poisoned stream), and graceful
 * shutdown. Plain async at the I/O edge (per the host's transport-edge convention), but every
 * failure is a typed ./errors class, never a bare string. D-004: the child receives ONLY the
 * {@link STDIO_CHILD_ENV_ALLOWLIST} vars plus the server config's explicit env - provider/API
 * keys and TREVOR_* state never reach an MCP child.
 *
 * Responsible for: the stdio child lifecycle, the MCP handshake, and framed JSON-RPC
 * request/response plumbing with classified failures.
 * Not for: frame byte-parsing (./framing) or capability discovery/caching (a later milestone).
 */

/** The protocol version this client requests. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Server-negotiated versions the client accepts; anything else is a handshake failure. */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS: readonly string[] = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

/** D-004: the ONLY host env vars an MCP stdio child inherits (plus explicit per-server env). */
export const STDIO_CHILD_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"] as const;

const DEFAULT_CLOSE_GRACE_MS = 2_000;
const STDERR_TAIL_CHARS = 2_048;

/** The secret-minimal child environment: allowlisted host vars, then explicit server env on top. */
export function stdioChildEnv(
  hostEnv: NodeJS.ProcessEnv,
  serverEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of STDIO_CHILD_ENV_ALLOWLIST) {
    const value = hostEnv[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return { ...env, ...serverEnv };
}

export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: unknown;
  readonly serverInfo?: unknown;
}

export interface McpStdioTransportState {
  readonly status: "configured" | "ready" | "failed" | "closed";
  readonly initialized: boolean;
  readonly protocolVersion?: string;
  readonly lastError?: string;
}

export interface McpStdioTransport {
  /** Runs the MCP handshake (initialize -> initialized notification); memoized. */
  readonly initialize: () => Promise<McpInitializeResult>;
  /** Sends a JSON-RPC request and resolves its correlated result. */
  readonly request: (method: string, params?: unknown) => Promise<unknown>;
  /** Sends a JSON-RPC notification (no id, no response). */
  readonly notify: (method: string, params?: unknown) => void;
  /** Drains pending requests and shuts the child down (graceful, then SIGKILL). Idempotent. */
  readonly close: () => Promise<void>;
  readonly state: () => McpStdioTransportState;
}

export interface StdioTransportOptions {
  /** The host environment to filter (default `process.env`); injectable for tests. */
  readonly hostEnv?: NodeJS.ProcessEnv;
  readonly clientInfo?: { readonly name: string; readonly version: string };
  /** How long close() waits for a voluntary exit before SIGKILL. */
  readonly closeGraceMs?: number;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: McpTransportError) => void;
  readonly timer: NodeJS.Timeout;
}

/** Spawns the server's child process and returns the transport over it. */
export function spawnStdioTransport(
  server: McpStdioServerConfig,
  options: StdioTransportOptions = {},
): McpStdioTransport {
  const clientInfo = options.clientInfo ?? { name: "trevor", version: "dev" };
  const closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;

  const child = spawn(server.command, [...server.args], {
    env: stdioChildEnv(options.hostEnv ?? process.env, server.env),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let status: McpStdioTransportState["status"] = "configured";
  let initialized = false;
  let protocolVersion: string | undefined;
  let lastError: string | undefined;
  /** The terminal failure every pending and future request gets; null while alive. */
  let fate: McpTransportError | null = null;
  let exited = false;
  let stderrTail = "";
  let nextId = 1;
  let initPromise: Promise<McpInitializeResult> | null = null;
  let closePromise: Promise<void> | null = null;
  const pending = new Map<number, PendingRequest>();
  const parser = createFrameParser();
  const exitWaiters: (() => void)[] = [];

  const settle = (id: number): PendingRequest | undefined => {
    const entry = pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(id);
    }
    return entry;
  };

  /** Every death path lands here exactly once: record the fate and drain pending requests.
   *  Failure paths reap the child immediately; the graceful close path shuts it down itself. */
  const terminate = (error: McpTransportError, terminalStatus: "failed" | "closed"): void => {
    if (fate) {
      return;
    }
    fate = error;
    status = terminalStatus;
    lastError = error.message;
    for (const id of [...pending.keys()]) {
      settle(id)?.reject(error);
    }
    if (terminalStatus === "failed" && !exited) {
      child.kill();
    }
  };

  const send = (message: Record<string, unknown>): void => {
    try {
      child.stdin.write(encodeFrame(JSON.stringify(message)));
    } catch {
      // A dead child's stdin can throw synchronously; the exit/error handlers classify it.
    }
  };

  const handleBody = (body: string): void => {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("not an object");
      }
      message = parsed as Record<string, unknown>;
    } catch {
      terminate(
        new McpMalformedResponseError({
          server: server.name,
          detail: `response body is not a JSON object: ${body.slice(0, 120)}`,
        }),
        "failed",
      );
      return;
    }

    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const entry = settle(message.id);
      if (!entry) {
        return; // a late response after timeout/close - nothing to correlate
      }
      if ("error" in message) {
        const error = (message.error ?? {}) as { code?: unknown; message?: unknown };
        const failure = new McpRpcError({
          server: server.name,
          method: entry.method,
          ...(typeof error.code === "number" ? { code: error.code } : {}),
          detail: typeof error.message === "string" ? error.message : "JSON-RPC error",
        });
        lastError = failure.message;
        entry.reject(failure);
        return;
      }
      entry.resolve(message.result);
      return;
    }

    if (typeof message.method === "string") {
      // A server-initiated request or notification. Elicitation/sampling mediation are later
      // milestones; per JSON-RPC, answer requests (they carry an id) with method-not-found.
      if (message.id !== undefined && !fate) {
        send({
          jsonrpc: "2.0",
          id: message.id as number | string,
          error: { code: -32601, message: `method not supported: ${message.method}` },
        });
      }
      return;
    }

    const entryId = typeof message.id === "number" ? message.id : undefined;
    const malformed = new McpMalformedResponseError({
      server: server.name,
      detail: "response carries neither result nor error",
    });
    if (entryId !== undefined) {
      settle(entryId)?.reject(malformed);
    }
    lastError = malformed.message;
  };

  child.stdout.on("data", (chunk: Buffer) => {
    let frames: string[];
    try {
      frames = parser.push(chunk);
    } catch (error) {
      terminate(
        new McpMalformedResponseError({
          server: server.name,
          detail: error instanceof Error ? error.message : String(error),
        }),
        "failed",
      );
      return;
    }
    for (const body of frames) {
      handleBody(body);
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
  });

  child.on("error", (error) => {
    terminate(
      new McpServerCrashError({ server: server.name, detail: error.message, cause: error }),
      "failed",
    );
  });

  child.on("exit", (code, signal) => {
    exited = true;
    for (const wake of exitWaiters.splice(0)) {
      wake();
    }
    terminate(
      new McpServerCrashError({
        server: server.name,
        detail:
          `child exited (code ${code ?? "null"}, signal ${signal ?? "null"})` +
          (stderrTail ? `; stderr tail: ${stderrTail.trim()}` : ""),
      }),
      "failed",
    );
  });

  // A dead child's pipes emit errors (EPIPE on stdin, resets on the read side); without
  // listeners Node rethrows them and crashes the host. The exit handler owns classification.
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});

  const request = (method: string, params?: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (fate) {
        reject(fate);
        return;
      }
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        const entry = settle(id);
        if (entry) {
          const timeout = new McpTimeoutError({
            server: server.name,
            method,
            timeoutMs: server.requestTimeoutMs,
          });
          lastError = timeout.message;
          entry.reject(timeout);
        }
      }, server.requestTimeoutMs);
      timer.unref?.();
      pending.set(id, { method, resolve, reject, timer });
      send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });

  const notify = (method: string, params?: unknown): void => {
    if (fate) {
      return;
    }
    send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  };

  const doInitialize = async (): Promise<McpInitializeResult> => {
    const raw = await request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo,
    });
    const result = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const version = result.protocolVersion;
    if (typeof version !== "string" || !SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(version)) {
      const failure = new McpHandshakeError({
        server: server.name,
        detail:
          typeof version === "string"
            ? `server negotiated unsupported protocolVersion "${version}"`
            : "initialize result lacks a protocolVersion",
      });
      terminate(failure, "failed");
      throw failure;
    }
    notify("notifications/initialized");
    initialized = true;
    protocolVersion = version;
    status = "ready";
    return {
      protocolVersion: version,
      capabilities: result.capabilities,
      ...(result.serverInfo !== undefined ? { serverInfo: result.serverInfo } : {}),
    };
  };

  const awaitExit = (timeoutMs: number): Promise<boolean> =>
    exited
      ? Promise.resolve(true)
      : new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), timeoutMs);
          timer.unref?.();
          exitWaiters.push(() => {
            clearTimeout(timer);
            resolve(true);
          });
        });

  const doClose = async (): Promise<void> => {
    // When a crash already sealed the fate this is pure cleanup: the transport keeps
    // reporting "failed" (the truthier state for /doctor) and the crash error as its fate.
    terminate(new McpClosedError({ server: server.name }), "closed");
    if (exited) {
      return;
    }
    child.stdin.end();
    if (!(await awaitExit(closeGraceMs))) {
      child.kill("SIGKILL");
      await awaitExit(closeGraceMs);
    }
  };

  return {
    initialize: () => {
      initPromise ??= doInitialize();
      return initPromise;
    },
    request,
    notify,
    close: () => {
      closePromise ??= doClose();
      return closePromise;
    },
    state: () => ({
      status,
      initialized,
      ...(protocolVersion ? { protocolVersion } : {}),
      ...(lastError ? { lastError } : {}),
    }),
  };
}
