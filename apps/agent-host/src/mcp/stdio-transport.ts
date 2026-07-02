import { spawn } from "node:child_process";
import { MINIMAL_CHILD_ENV_ALLOWLIST, minimalChildEnv } from "@host/processes/child-env";
import { msg } from "@host/transport/messages";
import type { McpStdioServerConfig } from "./config";
import {
  isMcpTransportError,
  McpClosedError,
  McpMalformedResponseError,
  McpRpcError,
  McpServerCrashError,
  McpTimeoutError,
  type McpTransportError,
  type McpTransportErrorTag,
} from "./errors";
import { createFrameParser, encodeFrame } from "./framing";
import {
  armRequestTimeout,
  decodeRpcError,
  type McpInitializeResult,
  type McpServerRequestHandler,
  type McpTransport,
  type McpTransportState,
  notificationEnvelope,
  performHandshake,
  requestEnvelope,
  responseEnvelope,
  serverRequestOutcome,
} from "./transport";

/**
 * The MCP stdio transport (plan 23 M2): spawns a configured server as a child process and
 * speaks JSON-RPC 2.0 over Content-Length-framed pipes - the initialize handshake with
 * protocolVersion negotiation, request/response correlation by id, per-request timeouts,
 * pending-request draining on every death path (crash, close, poisoned stream), and graceful
 * shutdown. Any handshake failure (negotiation reject, timeout, rpc error) is TERMINAL: the
 * transport parks in "failed" and the child is reaped, never left as a wedged zombie. Plain
 * async at the I/O edge (per the host's transport-edge convention), but every failure is a
 * typed ./errors class, never a bare string. D-004: the child receives ONLY the
 * {@link STDIO_CHILD_ENV_ALLOWLIST} vars plus the server config's explicit env - provider/API
 * keys and TREVOR_* state never reach an MCP child - and any server env VALUE that leaks into
 * the child's stderr is scrubbed before the tail reaches crash details.
 *
 * Responsible for: the stdio child lifecycle, the MCP handshake, and framed JSON-RPC
 * request/response plumbing with classified failures, behind the shared ./transport contract.
 * Not for: frame byte-parsing (./framing) or capability discovery/caching (./capabilities).
 */

/** D-004: the ONLY host env vars an MCP stdio child inherits (plus explicit per-server env);
 *  the shared processes/child-env policy under this transport's established name. */
export const STDIO_CHILD_ENV_ALLOWLIST = MINIMAL_CHILD_ENV_ALLOWLIST;

const DEFAULT_CLOSE_GRACE_MS = 2_000;
const STDERR_TAIL_CHARS = 2_048;

/** The secret-minimal child environment: allowlisted host vars, then explicit server env on top. */
export function stdioChildEnv(
  hostEnv: NodeJS.ProcessEnv,
  serverEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  return minimalChildEnv(hostEnv, serverEnv);
}

export interface StdioTransportOptions {
  /** The host environment to filter (default `process.env`); injectable for tests. */
  readonly hostEnv?: NodeJS.ProcessEnv;
  readonly clientInfo?: { readonly name: string; readonly version: string };
  /** How long close() waits for a voluntary exit before SIGKILL. */
  readonly closeGraceMs?: number;
  /** Answers server-originated requests (M6 mediation); absent means method-not-found. */
  readonly onServerRequest?: McpServerRequestHandler;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: McpTransportError) => void;
  readonly cancelTimeout: () => void;
}

/** Spawns the server's child process and returns the transport over it. */
export function spawnStdioTransport(
  server: McpStdioServerConfig,
  options: StdioTransportOptions = {},
): McpTransport {
  const clientInfo = options.clientInfo ?? { name: "trevor", version: "dev" };
  const closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;

  const child = spawn(server.command, [...server.args], {
    env: stdioChildEnv(options.hostEnv ?? process.env, server.env),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let status: McpTransportState["status"] = "configured";
  let initialized = false;
  let protocolVersion: string | undefined;
  let lastError: string | undefined;
  let lastErrorTag: McpTransportErrorTag | undefined;
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

  /** Records the failure as the transport's last error (message + machine-readable tag). */
  const fail = <E extends McpTransportError>(error: E): E => {
    lastError = error.message;
    lastErrorTag = error._tag;
    return error;
  };

  /** The stderr tail with every server env VALUE scrubbed - crash details flow to /doctor and
   *  the UI, and a server that echoes its own secrets must not smuggle them there. */
  const scrubbedStderrTail = (): string => {
    let tail = stderrTail.trim();
    for (const value of Object.values(server.env)) {
      if (value.length > 0) {
        tail = tail.split(value).join("[redacted]");
      }
    }
    return tail;
  };

  const settle = (id: number): PendingRequest | undefined => {
    const entry = pending.get(id);
    if (entry) {
      entry.cancelTimeout();
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
    fail(error);
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
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
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
        entry.reject(fail(decodeRpcError(server.name, entry.method, message.error, McpRpcError)));
        return;
      }
      entry.resolve(message.result);
      return;
    }

    if (typeof message.method === "string") {
      // A server-initiated request or notification. Requests (they carry an id) run through
      // the shared outcome ladder over the injected mediation handler (M6).
      if (message.id !== undefined && !fate) {
        const id = message.id as number | string;
        void serverRequestOutcome(options.onServerRequest, message.method, message.params).then(
          (outcome) => {
            if (!fate) {
              send(responseEnvelope(id, outcome));
            }
          },
        );
      }
      return;
    }

    const entryId = typeof message.id === "number" ? message.id : undefined;
    const malformed = fail(
      new McpMalformedResponseError({
        server: server.name,
        detail: "response carries neither result nor error",
      }),
    );
    if (entryId !== undefined) {
      settle(entryId)?.reject(malformed);
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    let frames: string[];
    try {
      frames = parser.push(chunk);
    } catch (error) {
      terminate(
        new McpMalformedResponseError({ server: server.name, detail: msg(error) }),
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
    const tail = scrubbedStderrTail();
    terminate(
      new McpServerCrashError({
        server: server.name,
        detail:
          `child exited (code ${code ?? "null"}, signal ${signal ?? "null"})` +
          (tail ? `; stderr tail: ${tail}` : ""),
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
      const cancelTimeout = armRequestTimeout(
        server.name,
        method,
        server.requestTimeoutMs,
        McpTimeoutError,
        (timeout) => {
          const entry = settle(id);
          if (entry) {
            entry.reject(fail(timeout));
          }
        },
      );
      pending.set(id, { method, resolve, reject, cancelTimeout });
      send(requestEnvelope(id, method, params));
    });

  const notify = (method: string, params?: unknown): void => {
    if (fate) {
      return;
    }
    send(notificationEnvelope(method, params));
  };

  const doInitialize = async (): Promise<McpInitializeResult> => {
    try {
      const result = await performHandshake(server.name, clientInfo, request, notify);
      initialized = true;
      protocolVersion = result.protocolVersion;
      status = "ready";
      return result;
    } catch (error) {
      // ANY handshake failure is terminal: without a completed handshake the child is a
      // zombie, so it is reaped and the transport parks in "failed" (never "configured").
      if (isMcpTransportError(error)) {
        terminate(error, "failed");
      }
      throw error;
    }
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
      ...(lastErrorTag ? { lastErrorTag } : {}),
    }),
  };
}
