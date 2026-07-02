import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { asRecord } from "@host/boot/decode";
import { createFrameParser, encodeFrame } from "@host/mcp/framing";
import {
  armRequestTimeout,
  decodeRpcError,
  notificationEnvelope,
  requestEnvelope,
  responseEnvelope,
} from "@host/mcp/transport";
import { minimalChildEnv } from "@host/processes/child-env";
import { clipLine } from "@host/tools/shared";
import { msg } from "@host/transport/messages";
import type { LspSpawnSpec } from "./adapter";
import {
  capItems,
  MAX_LSP_DIAGNOSTIC_MESSAGE_CHARS,
  MAX_LSP_SERVER_LOG_CHARS,
  MAX_LSP_STORED_DIAGNOSTICS_PER_FILE,
  MAX_LSP_STORED_FILES,
} from "./caps";
import { type LspDiagnostic, lspSeverityName, rangeFromLsp } from "./contract";
import {
  isLspClientError,
  type LspClientError,
  type LspClientErrorTag,
  LspClosedError,
  LspHandshakeError,
  LspMalformedResponseError,
  LspRpcError,
  LspServerCrashError,
  LspTimeoutError,
} from "./errors";

/**
 * The LSP JSON-RPC client over stdio (plan 24 M2): spawns one language server as a child
 * process and speaks LSP - the initialize/initialized handshake with capability capture,
 * request/response correlation by id with per-request timeouts, didOpen/didChange/didClose
 * document sync (read-only tools still open documents so push-model servers publish
 * diagnostics; identical content skips the re-sync and keeps the stored publish), a per-uri
 * publishDiagnostics store decoded to the ./contract shapes (version-gated - a publish tagged
 * for an earlier document version is dropped - and bounded to MAX_LSP_STORED_FILES entries),
 * graceful shutdown (shutdown request -> exit notification -> grace -> kill), and crash
 * tracking with a bounded stderr tail. Mirrors mcp/stdio-transport's hygiene: the shared
 * minimal child env policy (processes/child-env, D-004), unref'd + cleared timers, pending-map
 * draining on every death path, and a terminal fate that answers all later requests - every
 * failure path reaps the child through the SIGTERM -> grace -> SIGKILL ladder, never leaving
 * a zombie.
 *
 * Wire format: LSP's Content-Length framing IS the framing mcp/framing.ts implements (that
 * module is even documented as "LSP-style"), so this client imports it rather than duplicating
 * a byte parser; the JSON-RPC envelope builders, per-request deadline, and rpc-error decode in
 * mcp/transport.ts are protocol-neutral and shared the same way (the error VOCABULARY stays
 * Lsp*). That cross-subsystem reuse is ACCEPTED coupling for now - if a third JSON-RPC
 * consumer appears, framing/envelopes deserve a protocol-neutral shared home.
 *
 * Responsible for: one language server's child lifecycle, framed JSON-RPC plumbing with
 * classified failures, document sync, and the published-diagnostics store.
 * Not for: adapter selection or workspace status (./manager) and result caps (./caps).
 */

export const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_LSP_INIT_TIMEOUT_MS = 10_000;

/** How long waitForDiagnostics waits for a publish by default (still capped by the request
 *  timeout): publishes follow a sync within moments, so waiters never need the full deadline. */
export const DEFAULT_LSP_PUBLISH_WAIT_MS = 3_000;

const DEFAULT_CLOSE_GRACE_MS = 2_000;
const SHUTDOWN_REQUEST_TIMEOUT_MS = 2_000;

/** How one child exit is reported to the manager: expected (shutdown) or a crash. */
export interface LspExitInfo {
  readonly expected: boolean;
  readonly detail: string;
}

export interface LspClientOptions {
  /** The server's display name for errors and status ("typescript-language-server"). */
  readonly serverName: string;
  readonly spawn: LspSpawnSpec;
  readonly workspaceRoot: string;
  /** LSP initializationOptions (the adapter's). */
  readonly initializeOptions?: unknown;
  /** The host environment to filter (default `process.env`); injectable for tests. */
  readonly hostEnv?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  /** The initialize handshake's own (usually longer) deadline. */
  readonly initTimeoutMs?: number;
  /** waitForDiagnostics' default deadline; capped by requestTimeoutMs. */
  readonly publishWaitMs?: number;
  /** How long shutdown waits for a voluntary exit before SIGKILL. */
  readonly closeGraceMs?: number;
  /** Crash/exit notification for the manager's restart policy. */
  readonly onExit?: (info: LspExitInfo) => void;
}

export interface LspInitializeResult {
  readonly capabilities: Record<string, unknown>;
  readonly serverInfo?: unknown;
}

export interface LspClientState {
  /** Usable: spawned, not exited, and no terminal fate sealed. */
  readonly alive: boolean;
  readonly initialized: boolean;
  readonly lastError?: string;
  readonly lastErrorTag?: LspClientErrorTag;
  /** The bounded stderr tail (crash forensics). */
  readonly stderrTail: string;
}

export interface LspClient {
  /** Runs the LSP handshake (initialize -> initialized notification); memoized. */
  readonly initialize: () => Promise<LspInitializeResult>;
  /** Sends a JSON-RPC request and resolves its correlated result. */
  readonly request: (method: string, params?: unknown) => Promise<unknown>;
  /** Sends a JSON-RPC notification (no id, no response). */
  readonly notify: (method: string, params?: unknown) => void;
  /** Opens (or, when already open, fully re-syncs) a document so the server analyzes it. */
  readonly openDocument: (uri: string, languageId: string, text: string) => void;
  readonly closeDocument: (uri: string) => void;
  /** The last published diagnostics for a uri; undefined when none arrived since last sync. */
  readonly diagnosticsFor: (uri: string) => readonly LspDiagnostic[] | undefined;
  /** Every uri's last published diagnostics (the lsp_diagnostics workspace-summary read model). */
  readonly diagnosticsSnapshot: () => readonly {
    readonly uri: string;
    readonly diagnostics: readonly LspDiagnostic[];
  }[];
  /** Resolves with the next published diagnostics for the uri (or the already-arrived set);
   *  undefined when the server publishes nothing within the deadline (default: the dedicated
   *  publish-wait deadline, capped by the request timeout). Never throws. */
  readonly waitForDiagnostics: (
    uri: string,
    timeoutMs?: number,
  ) => Promise<readonly LspDiagnostic[] | undefined>;
  /** The server capabilities captured from the initialize result. */
  readonly capabilities: () => Record<string, unknown> | undefined;
  /** Graceful shutdown: shutdown request -> exit notification -> grace -> kill. Idempotent. */
  readonly shutdown: () => Promise<void>;
  readonly state: () => LspClientState;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: LspClientError) => void;
  readonly cancelTimeout: () => void;
}

/** Spawns the language server's child process and returns the client over it. */
export function spawnLspClient(options: LspClientOptions): LspClient {
  const serverName = options.serverName;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS;
  const initTimeoutMs = options.initTimeoutMs ?? DEFAULT_LSP_INIT_TIMEOUT_MS;
  const publishWaitMs = Math.min(
    options.publishWaitMs ?? DEFAULT_LSP_PUBLISH_WAIT_MS,
    requestTimeoutMs,
  );
  const closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;

  const child = spawn(options.spawn.command, [...options.spawn.args], {
    env: minimalChildEnv(options.hostEnv ?? process.env),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let initialized = false;
  let capabilities: Record<string, unknown> | undefined;
  let lastError: string | undefined;
  let lastErrorTag: LspClientErrorTag | undefined;
  /** The terminal failure every pending and future request gets; null while alive. */
  let fate: LspClientError | null = null;
  let exited = false;
  let closing = false;
  let stderrTail = "";
  let nextId = 1;
  let initPromise: Promise<LspInitializeResult> | null = null;
  let closePromise: Promise<void> | null = null;
  const pending = new Map<number, PendingRequest>();
  const parser = createFrameParser();
  const exitWaiters: (() => void)[] = [];

  /** Open documents' sync versions, keyed by uri. */
  const documentVersions = new Map<string, number>();
  /** Open documents' last synced text, keyed by uri (the unchanged-content sync guard). */
  const documentTexts = new Map<string, string>();
  /** The last published diagnostics per uri, decoded and bounded; capped at
   *  MAX_LSP_STORED_FILES entries with oldest-insertion eviction. */
  const published = new Map<string, readonly LspDiagnostic[]>();
  /** Waiters for the next publishDiagnostics per uri. */
  const diagnosticWaiters = new Map<string, ((d?: readonly LspDiagnostic[]) => void)[]>();

  const fail = <E extends LspClientError>(error: E): E => {
    lastError = error.message;
    lastErrorTag = error._tag;
    return error;
  };

  const boundedStderrTail = (): string => stderrTail.trim();

  const settle = (id: number): PendingRequest | undefined => {
    const entry = pending.get(id);
    if (entry) {
      entry.cancelTimeout();
      pending.delete(id);
    }
    return entry;
  };

  const wakeDiagnosticWaiters = (uri: string, diagnostics?: readonly LspDiagnostic[]): void => {
    for (const wake of diagnosticWaiters.get(uri)?.splice(0) ?? []) {
      wake(diagnostics);
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

  /** Every death path lands here exactly once: record the fate and drain every waiter.
   *  Failure paths reap the child immediately - SIGTERM, then SIGKILL after the grace window
   *  (the same ladder shutdown uses), so a child that ignores SIGTERM cannot linger; the
   *  graceful shutdown path owns its own exit. */
  const terminate = (error: LspClientError, terminalKind: "failed" | "closed"): void => {
    if (fate) {
      return;
    }
    fate = error;
    fail(error);
    for (const id of [...pending.keys()]) {
      settle(id)?.reject(error);
    }
    for (const uri of [...diagnosticWaiters.keys()]) {
      wakeDiagnosticWaiters(uri, published.get(uri));
    }
    if (terminalKind === "failed" && !exited) {
      child.kill();
      void awaitExit(closeGraceMs).then((exitedInGrace) => {
        if (!exitedInGrace) {
          child.kill("SIGKILL");
        }
      });
    }
  };

  const send = (message: Record<string, unknown>): void => {
    try {
      child.stdin.write(encodeFrame(JSON.stringify(message)));
    } catch {
      // A dead child's stdin can throw synchronously; the exit/error handlers classify it.
    }
  };

  const requestWithTimeout = (
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (fate) {
        reject(fate);
        return;
      }
      const id = nextId;
      nextId += 1;
      const cancelTimeout = armRequestTimeout(
        serverName,
        method,
        timeoutMs,
        LspTimeoutError,
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

  /** Decodes one publishDiagnostics params object into bounded contract diagnostics. A publish
   *  tagged with a version OLDER than the document's current sync is a stale wave for previous
   *  content and is dropped - the store keeps waiting for the current version's publish. */
  const storePublishedDiagnostics = (raw: unknown): void => {
    const params = asRecord(raw);
    const uri = typeof params?.uri === "string" ? params.uri : undefined;
    if (!uri) {
      return;
    }
    const version = typeof params?.version === "number" ? params.version : undefined;
    const currentVersion = documentVersions.get(uri);
    if (version !== undefined && currentVersion !== undefined && version < currentVersion) {
      return;
    }
    const entries = Array.isArray(params?.diagnostics) ? params.diagnostics : [];
    const decoded = entries.map((entry): LspDiagnostic => {
      const record = asRecord(entry) ?? {};
      return {
        range: rangeFromLsp(record.range),
        severity: lspSeverityName(record.severity),
        message: clipLine(
          typeof record.message === "string" ? record.message : "",
          MAX_LSP_DIAGNOSTIC_MESSAGE_CHARS,
        ),
        ...(typeof record.source === "string" ? { source: record.source } : {}),
        ...(typeof record.code === "string" || typeof record.code === "number"
          ? { code: String(record.code) }
          : {}),
      };
    });
    const bounded = capItems(decoded, MAX_LSP_STORED_DIAGNOSTICS_PER_FILE).items;
    published.set(uri, bounded);
    if (published.size > MAX_LSP_STORED_FILES) {
      // Evict the oldest entry (insertion order) so a long session cannot grow unbounded.
      const oldest = published.keys().next().value;
      if (oldest !== undefined) {
        published.delete(oldest);
      }
    }
    wakeDiagnosticWaiters(uri, bounded);
  };

  const handleNotification = (method: string, params: unknown): void => {
    if (method === "textDocument/publishDiagnostics") {
      storePublishedDiagnostics(params);
    }
    // Other server notifications (logMessage, progress) are deliberately ignored: pull-only.
  };

  const handleBody = (body: string): void => {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(body);
      const record = asRecord(parsed);
      if (!record) {
        throw new Error("not an object");
      }
      message = record;
    } catch {
      terminate(
        fail(
          new LspMalformedResponseError({
            server: serverName,
            detail: `response body is not a JSON object: ${body.slice(0, 120)}`,
          }),
        ),
        "failed",
      );
      return;
    }

    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const entry = settle(message.id);
      if (!entry) {
        return; // a late response after timeout/shutdown - nothing to correlate
      }
      if ("error" in message) {
        entry.reject(fail(decodeRpcError(serverName, entry.method, message.error, LspRpcError)));
        return;
      }
      entry.resolve(message.result);
      return;
    }

    if (typeof message.method === "string") {
      if (message.id === undefined) {
        handleNotification(message.method, message.params);
        return;
      }
      // A server-originated request (workspace/configuration, client/registerCapability, ...).
      // The read-only first cut answers method-not-found; servers treat that as "no answer"
      // and fall back to their defaults (the MCP no-handler ladder, plan 23 precedent).
      if (!fate) {
        send(
          responseEnvelope(message.id as number | string, {
            error: { code: -32601, message: `method not supported: ${message.method}` },
          }),
        );
      }
      return;
    }

    const entryId = typeof message.id === "number" ? message.id : undefined;
    const malformed = fail(
      new LspMalformedResponseError({
        server: serverName,
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
        fail(new LspMalformedResponseError({ server: serverName, detail: msg(error) })),
        "failed",
      );
      return;
    }
    for (const body of frames) {
      handleBody(body);
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-MAX_LSP_SERVER_LOG_CHARS);
  });

  child.on("error", (error) => {
    terminate(
      fail(new LspServerCrashError({ server: serverName, detail: error.message, cause: error })),
      "failed",
    );
  });

  child.on("exit", (code, signal) => {
    exited = true;
    for (const wake of exitWaiters.splice(0)) {
      wake();
    }
    const tail = boundedStderrTail();
    const detail =
      `child exited (code ${code ?? "null"}, signal ${signal ?? "null"})` +
      (tail ? `; stderr tail: ${tail}` : "");
    if (!closing) {
      terminate(fail(new LspServerCrashError({ server: serverName, detail })), "failed");
    } else {
      // Shutdown-path exits still release any diagnostics waiters.
      for (const uri of [...diagnosticWaiters.keys()]) {
        wakeDiagnosticWaiters(uri, published.get(uri));
      }
    }
    options.onExit?.({ expected: closing, detail });
  });

  // A dead child's pipes emit errors (EPIPE on stdin, resets on the read side); without
  // listeners Node rethrows them and crashes the host. The exit handler owns classification.
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});

  const doInitialize = async (): Promise<LspInitializeResult> => {
    try {
      const raw = await requestWithTimeout(
        "initialize",
        {
          processId: process.pid,
          rootUri: pathToFileURL(options.workspaceRoot).href,
          workspaceFolders: [
            { uri: pathToFileURL(options.workspaceRoot).href, name: options.workspaceRoot },
          ],
          capabilities: {
            textDocument: {
              hover: { contentFormat: ["markdown", "plaintext"] },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              publishDiagnostics: {},
              codeAction: {
                codeActionLiteralSupport: {
                  codeActionKind: { valueSet: ["quickfix", "refactor", "source"] },
                },
              },
            },
            workspace: { symbol: {} },
          },
          ...(options.initializeOptions !== undefined
            ? { initializationOptions: options.initializeOptions }
            : {}),
        },
        initTimeoutMs,
      );
      const record = asRecord(raw);
      if (!record) {
        throw fail(
          new LspHandshakeError({
            server: serverName,
            detail: "initialize result is not an object",
          }),
        );
      }
      capabilities = asRecord(record.capabilities) ?? {};
      initialized = true;
      send(notificationEnvelope("initialized", {}));
      return {
        capabilities,
        ...(record.serverInfo !== undefined ? { serverInfo: record.serverInfo } : {}),
      };
    } catch (error) {
      // ANY handshake failure is terminal: without a completed handshake the child is a
      // zombie, so it is reaped and every later request gets the sealed fate.
      if (isLspClientError(error)) {
        terminate(error, "failed");
      }
      throw error;
    }
  };

  const doShutdown = async (): Promise<void> => {
    closing = true;
    if (!exited && fate === null) {
      try {
        await requestWithTimeout("shutdown", null, SHUTDOWN_REQUEST_TIMEOUT_MS);
      } catch {
        // A server that cannot answer shutdown still gets the exit notification below.
      }
    }
    terminate(new LspClosedError({ server: serverName }), "closed");
    if (exited) {
      return;
    }
    send(notificationEnvelope("exit"));
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
    request: (method, params) => requestWithTimeout(method, params, requestTimeoutMs),
    notify: (method, params) => {
      if (!fate) {
        send(notificationEnvelope(method, params));
      }
    },
    openDocument: (uri, languageId, text) => {
      if (fate) {
        return;
      }
      const version = documentVersions.get(uri);
      if (version !== undefined && documentTexts.get(uri) === text) {
        return; // identical content is already synced; the stored publish stays valid
      }
      published.delete(uri); // the previous publish is stale for the new content
      documentTexts.set(uri, text);
      if (version === undefined) {
        documentVersions.set(uri, 1);
        send(
          notificationEnvelope("textDocument/didOpen", {
            textDocument: { uri, languageId, version: 1, text },
          }),
        );
      } else {
        const next = version + 1;
        documentVersions.set(uri, next);
        send(
          notificationEnvelope("textDocument/didChange", {
            textDocument: { uri, version: next },
            contentChanges: [{ text }], // full sync - the simplest correct first cut
          }),
        );
      }
    },
    closeDocument: (uri) => {
      if (fate || !documentVersions.has(uri)) {
        return;
      }
      documentVersions.delete(uri);
      documentTexts.delete(uri);
      published.delete(uri);
      send(notificationEnvelope("textDocument/didClose", { textDocument: { uri } }));
    },
    diagnosticsFor: (uri) => published.get(uri),
    diagnosticsSnapshot: () =>
      [...published.entries()].map(([uri, diagnostics]) => ({ uri, diagnostics })),
    waitForDiagnostics: (uri, timeoutMs = publishWaitMs) => {
      const arrived = published.get(uri);
      if (arrived !== undefined || fate) {
        return Promise.resolve(arrived);
      }
      return new Promise((resolve) => {
        const waiters = diagnosticWaiters.get(uri) ?? [];
        diagnosticWaiters.set(uri, waiters);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(wake);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          resolve(undefined);
        }, timeoutMs);
        timer.unref?.();
        const wake = (diagnostics?: readonly LspDiagnostic[]): void => {
          clearTimeout(timer);
          resolve(diagnostics);
        };
        waiters.push(wake);
      });
    },
    capabilities: () => capabilities,
    shutdown: () => {
      closePromise ??= doShutdown();
      return closePromise;
    },
    state: () => ({
      alive: !exited && fate === null,
      initialized,
      ...(lastError ? { lastError } : {}),
      ...(lastErrorTag ? { lastErrorTag } : {}),
      stderrTail: boundedStderrTail(),
    }),
  };
}
