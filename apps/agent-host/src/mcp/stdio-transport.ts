import { MINIMAL_CHILD_ENV_ALLOWLIST, minimalChildEnv } from "@host/processes/child-env";
import { reap, reapAfterGrace, spawnHardenedChild } from "@host/processes/child-spawn";
import { createFramedJsonRpcConnection } from "../json-rpc/framed-connection";
import { type ServerRequestHandler, serverRequestOutcome } from "../json-rpc/rpc";
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
import {
  type McpInitializeResult,
  type McpTransport,
  type McpTransportState,
  performHandshake,
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
  readonly onServerRequest?: ServerRequestHandler;
}

/** Spawns the server's child process and returns the transport over it. */
export function spawnStdioTransport(
  server: McpStdioServerConfig,
  options: StdioTransportOptions = {},
): McpTransport {
  const clientInfo = options.clientInfo ?? { name: "trevor", version: "dev" };
  const closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;

  const child = spawnHardenedChild({
    command: server.command,
    args: server.args,
    env: stdioChildEnv(options.hostEnv ?? process.env, server.env),
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
  let initPromise: Promise<McpInitializeResult> | null = null;
  let closePromise: Promise<void> | null = null;
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

  /** Every death path lands here exactly once: record the fate and drain pending requests.
   *  Failure paths reap the child immediately; the graceful close path shuts it down itself. */
  const terminate = (error: McpTransportError, terminalStatus: "failed" | "closed"): void => {
    if (fate) {
      return;
    }
    fate = error;
    status = terminalStatus;
    fail(error);
    if (terminalStatus === "failed" && !exited) {
      child.kill("SIGTERM");
      reapAfterGrace(child, closeGraceMs);
    }
  };

  const connection = createFramedJsonRpcConnection<McpTransportError>({
    child,
    server: server.name,
    defaultTimeoutMs: server.requestTimeoutMs,
    timeoutError: McpTimeoutError,
    rpcError: McpRpcError,
    malformedError: (detail) => new McpMalformedResponseError({ server: server.name, detail }),
    recordError: fail,
    onFatal: (error) => terminate(error, "failed"),
    onServerRequest: (method, params) =>
      serverRequestOutcome(options.onServerRequest, method, params),
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
  });

  child.on("error", (error) => {
    connection.terminate(
      new McpServerCrashError({ server: server.name, detail: error.message, cause: error }),
    );
  });

  child.on("exit", (code, signal) => {
    exited = true;
    for (const wake of exitWaiters.splice(0)) {
      wake();
    }
    const tail = scrubbedStderrTail();
    connection.terminate(
      new McpServerCrashError({
        server: server.name,
        detail:
          `child exited (code ${code ?? "null"}, signal ${signal ?? "null"})` +
          (tail ? `; stderr tail: ${tail}` : ""),
      }),
    );
  });

  const request = (method: string, params?: unknown): Promise<unknown> =>
    connection.request(method, params);

  const notify = (method: string, params?: unknown): void => connection.notify(method, params);

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
        connection.terminate(error);
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
    if (!fate) {
      fate = new McpClosedError({ server: server.name });
      status = "closed";
      fail(fate);
      connection.terminate(fate);
    }
    if (exited) {
      return;
    }
    child.stdin.end();
    if (!(await awaitExit(closeGraceMs))) {
      await reap(child, { graceMs: closeGraceMs });
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
