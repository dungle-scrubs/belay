import { resolve } from "node:path";
import { WORKSPACE_ROOT } from "@host/boot/paths";
import { msg } from "@host/transport/messages";
import {
  createTypeScriptLanguageServerAdapter,
  type LanguageServerAdapter,
  type LspSpawnSpec,
} from "./adapter";
import {
  DEFAULT_LSP_INIT_TIMEOUT_MS,
  DEFAULT_LSP_REQUEST_TIMEOUT_MS,
  type LspClient,
  type LspExitInfo,
  spawnLspClient,
} from "./client";
import {
  degraded,
  type LspDegraded,
  type LspOutcome,
  type LspServerStatus,
  type LspStoredDiagnosticsSummary,
  ok,
} from "./contract";
import { isLspClientError } from "./errors";

/**
 * The host-owned LSP runtime manager (plan 24 M2, D-001): per-workspace-root language-server
 * state behind one seam the M3-M5 tools program against. The first cut serves the host's one
 * WORKSPACE_ROOT, but state is keyed per root so multi-root support is a config change, not a
 * redesign. Servers spawn LAZILY on first use; adapter selection is cached per root; a crash
 * consumes a bounded restart budget (respawn on next use, then parked as error - but a server
 * that had been ready for over {@link READY_RESTART_BUDGET_RESET_MS} earns a fresh budget
 * first, so a long-healthy root never parks on an occasional crash); an initialize failure
 * parks the root immediately (no respawn storms). Every miss - no adapter, missing binary,
 * timeout, crash, closed - surfaces as a plain degraded result variant (./contract, D-006):
 * nothing here ever throws through a turn. The idle status branch caches the adapter's binary
 * resolution per root (invalidated on crash or a failed spawn), so status snapshots never walk
 * PATH on every call.
 *
 * Responsible for: workspace-root keyed lifecycle state, adapter selection, lazy spawn,
 * degrade-mapping of typed client failures, restart policy, and status snapshots.
 * Not for: wire mechanics (./client), project-family detection (./adapter), or result shapes
 * (./contract).
 */

export const DEFAULT_LSP_STALE_AFTER_MS = 5 * 60_000;
export const DEFAULT_LSP_MAX_AUTO_RESTARTS = 1;

/** A server ready for longer than this earns a fresh restart budget when it crashes: budget
 *  exhaustion should park a crash LOOP, not a root whose server died weeks apart. */
export const READY_RESTART_BUDGET_RESET_MS = 10 * 60_000;

export interface LspManagerOptions {
  /** Adapter candidates in priority order (default: the TS/JS adapter, D-004). */
  readonly adapters?: readonly LanguageServerAdapter[];
  /** The root served when a call names none (default: the host's WORKSPACE_ROOT). */
  readonly defaultWorkspaceRoot?: string;
  readonly hostEnv?: NodeJS.ProcessEnv;
  /** The clock behind staleness and request stamps (default `Date.now`); injectable. */
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  readonly initTimeoutMs?: number;
  /** The clients' default publish-wait deadline (capped by requestTimeoutMs). */
  readonly publishWaitMs?: number;
  /** A ready server quiet for longer than this reports "stale" (with its age). */
  readonly staleAfterMs?: number;
  /** Crash respawns granted before the root parks as "error". */
  readonly maxAutoRestarts?: number;
  readonly closeGraceMs?: number;
}

/** A usable server, or the degraded variant the caller renders as bounded text. */
export type LspAcquireOutcome =
  | { readonly kind: "ready"; readonly client: LspClient; readonly server: string }
  | LspDegraded;

export interface LspManager {
  /** Lazily spawns + initializes the root's server; degradation is a result, never a throw. */
  readonly acquire: (workspaceRoot?: string) => Promise<LspAcquireOutcome>;
  /** One request through the root's server, with typed failures mapped to degraded results. */
  readonly request: (
    method: string,
    params?: unknown,
    workspaceRoot?: string,
  ) => Promise<LspOutcome<unknown>>;
  /** The root's status snapshot (D-008 vocabulary: configured/missing/unavailable/initializing/
   *  ready/stale/error/timeout, plus last request, last error, stale age, restarts). */
  readonly status: (workspaceRoot?: string) => LspServerStatus;
  /** Every touched root's status (the default root always included). */
  readonly statusSnapshot: () => readonly LspServerStatus[];
  /** Shuts every managed server down; idempotent. Later acquires degrade. */
  readonly close: () => Promise<void>;
}

interface WorkspaceEntry {
  readonly root: string;
  adapterResolved: boolean;
  adapter?: LanguageServerAdapter;
  client?: LspClient;
  initPromise?: Promise<LspAcquireOutcome>;
  initializing: boolean;
  ready: boolean;
  /** When the current server became ready; cleared on crash. Backs the budget reset. */
  readySince?: number;
  /** A parked terminal failure: acquires answer this without respawning. */
  failure?: { readonly status: "timeout" | "error"; readonly outcome: LspDegraded };
  restarts: number;
  lastError?: string;
  lastRequestMethod?: string;
  lastRequestAt?: number;
  /** The last successful server response (initialize or request); drives staleness. */
  lastActivityAt?: number;
  /** The idle status branch's cached binary resolution (E4): refreshed by every acquire,
   *  invalidated on crash or a failed spawn, so statusSnapshot never stats per call. */
  commandResolved: boolean;
  command?: LspSpawnSpec;
}

export function createLspManager(options: LspManagerOptions = {}): LspManager {
  const adapters = options.adapters ?? [
    createTypeScriptLanguageServerAdapter(options.hostEnv ? { hostEnv: options.hostEnv } : {}),
  ];
  const defaultRoot = resolve(options.defaultWorkspaceRoot ?? WORKSPACE_ROOT);
  const now = options.now ?? Date.now;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS;
  const initTimeoutMs = options.initTimeoutMs ?? DEFAULT_LSP_INIT_TIMEOUT_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_LSP_STALE_AFTER_MS;
  const maxAutoRestarts = options.maxAutoRestarts ?? DEFAULT_LSP_MAX_AUTO_RESTARTS;

  const entries = new Map<string, WorkspaceEntry>();
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const ensureEntry = (workspaceRoot?: string): WorkspaceEntry => {
    const root = resolve(workspaceRoot ?? defaultRoot);
    let entry = entries.get(root);
    if (!entry) {
      entry = {
        root,
        adapterResolved: false,
        initializing: false,
        ready: false,
        restarts: 0,
        commandResolved: false,
      };
      entries.set(root, entry);
    }
    return entry;
  };

  /** Adapter selection, cached per root: the first adapter that detects the workspace. */
  const adapterOf = (entry: WorkspaceEntry): LanguageServerAdapter | undefined => {
    if (!entry.adapterResolved) {
      entry.adapter = adapters.find((adapter) => adapter.detects(entry.root));
      entry.adapterResolved = true;
    }
    return entry.adapter;
  };

  /** Maps a typed client failure onto the degraded vocabulary (D-006). */
  const degradeError = (error: unknown): LspDegraded => {
    if (isLspClientError(error)) {
      switch (error._tag) {
        case "LspTimeoutError":
          return degraded("timeout", error.message);
        case "LspClosedError":
          return degraded("unavailable", error.message);
        default:
          return degraded("server_error", error.message);
      }
    }
    return degraded("server_error", msg(error));
  };

  /** The crash policy (unexpected exits after ready): one budgeted lazy respawn, then parked.
   *  A server that had been ready past READY_RESTART_BUDGET_RESET_MS earns a fresh budget
   *  first - exhaustion parks crash LOOPS, never a root whose crashes are weeks apart. */
  const handleExit = (entry: WorkspaceEntry, info: LspExitInfo): void => {
    if (info.expected || closed || !entry.ready) {
      return; // initialize-phase failures classify through the initialize rejection instead
    }
    if (
      entry.readySince !== undefined &&
      now() - entry.readySince > READY_RESTART_BUDGET_RESET_MS
    ) {
      entry.restarts = 0;
    }
    entry.ready = false;
    entry.readySince = undefined;
    entry.client = undefined;
    entry.initPromise = undefined;
    entry.commandResolved = false; // the binary may have changed; the next status re-checks
    entry.restarts += 1;
    entry.lastError = info.detail;
    if (entry.restarts > maxAutoRestarts) {
      const server = adapterOf(entry)?.displayName ?? "the language server";
      entry.failure = {
        status: "error",
        outcome: degraded(
          "server_error",
          `${server} crashed ${entry.restarts} times; not restarting again: ${info.detail}`,
        ),
      };
    }
  };

  const spawnAndInitialize = async (
    entry: WorkspaceEntry,
    adapter: LanguageServerAdapter,
    spawnSpec: { readonly command: string; readonly args: readonly string[] },
  ): Promise<LspAcquireOutcome> => {
    entry.initializing = true;
    const client = spawnLspClient({
      serverName: adapter.displayName,
      spawn: spawnSpec,
      workspaceRoot: entry.root,
      ...(adapter.initializeOptions !== undefined
        ? { initializeOptions: adapter.initializeOptions }
        : {}),
      ...(options.hostEnv ? { hostEnv: options.hostEnv } : {}),
      requestTimeoutMs,
      initTimeoutMs,
      ...(options.publishWaitMs !== undefined ? { publishWaitMs: options.publishWaitMs } : {}),
      ...(options.closeGraceMs !== undefined ? { closeGraceMs: options.closeGraceMs } : {}),
      onExit: (info) => handleExit(entry, info),
    });
    entry.client = client;
    try {
      await client.initialize();
      entry.initializing = false;
      entry.ready = true;
      entry.readySince = now();
      entry.lastActivityAt = now();
      return { kind: "ready", client, server: adapter.displayName };
    } catch (error) {
      // An initialize failure parks the root (client is already reaped by the handshake's
      // terminal discipline): repeated acquires answer from the parked outcome, no respawn storm.
      entry.initializing = false;
      entry.client = undefined;
      entry.commandResolved = false; // this spawn attempt failed; the next status re-checks
      entry.lastError = msg(error);
      const outcome = degradeError(error);
      entry.failure = {
        status: outcome.reason === "timeout" ? "timeout" : "error",
        outcome,
      };
      return outcome;
    }
  };

  const acquire = async (workspaceRoot?: string): Promise<LspAcquireOutcome> => {
    if (closed) {
      return degraded("unavailable", "the LSP manager is closed");
    }
    const entry = ensureEntry(workspaceRoot);
    const adapter = adapterOf(entry);
    if (!adapter) {
      return degraded(
        "unavailable",
        `no language-server adapter matches ${entry.root} (TypeScript/JavaScript is the first-cut family)`,
      );
    }
    if (entry.failure) {
      return entry.failure.outcome;
    }
    if (entry.ready && entry.client) {
      return { kind: "ready", client: entry.client, server: adapter.displayName };
    }
    if (!entry.initPromise) {
      // Acquire is about to spawn, so it always resolves FRESH (a binary installed since the
      // last look must be found) and refreshes the status branch's cache with what it saw.
      const spawnSpec = adapter.resolveCommand(entry.root);
      entry.command = spawnSpec;
      entry.commandResolved = true;
      if (!spawnSpec) {
        return degraded(
          "unavailable",
          `${adapter.displayName} is not installed (checked ${entry.root}/node_modules/.bin and PATH)`,
        );
      }
      entry.initPromise = spawnAndInitialize(entry, adapter, spawnSpec);
    }
    return entry.initPromise;
  };

  const request = async (
    method: string,
    params?: unknown,
    workspaceRoot?: string,
  ): Promise<LspOutcome<unknown>> => {
    const acquired = await acquire(workspaceRoot);
    if (acquired.kind === "degraded") {
      return acquired;
    }
    const entry = ensureEntry(workspaceRoot);
    entry.lastRequestMethod = method;
    entry.lastRequestAt = now();
    try {
      const value = await acquired.client.request(method, params);
      entry.lastActivityAt = now();
      return ok(value);
    } catch (error) {
      entry.lastError = msg(error);
      return degradeError(error);
    }
  };

  /** Bounded counts over the live client's stored publishes (plan 24 M8); undefined until any
   *  file carries diagnostics, so an idle snapshot stays free of empty noise. */
  const storedDiagnosticsOf = (entry: WorkspaceEntry): LspStoredDiagnosticsSummary | undefined => {
    const stored = (entry.client?.diagnosticsSnapshot() ?? []).filter(
      (file) => file.diagnostics.length > 0,
    );
    if (stored.length === 0) {
      return undefined;
    }
    const all = stored.flatMap((file) => file.diagnostics);
    return {
      files: stored.length,
      errors: all.filter((diagnostic) => diagnostic.severity === "error").length,
      warnings: all.filter((diagnostic) => diagnostic.severity === "warning").length,
    };
  };

  const statusOf = (entry: WorkspaceEntry): LspServerStatus => {
    const adapter = adapterOf(entry);
    const diagnostics = storedDiagnosticsOf(entry);
    const base = {
      workspaceRoot: entry.root,
      restarts: entry.restarts,
      ...(adapter ? { server: adapter.displayName } : {}),
      ...(entry.lastRequestMethod ? { lastRequestMethod: entry.lastRequestMethod } : {}),
      ...(entry.lastRequestAt !== undefined ? { lastRequestAt: entry.lastRequestAt } : {}),
      ...(entry.lastError ? { lastError: entry.lastError } : {}),
      ...(diagnostics ? { diagnostics } : {}),
    };
    if (!adapter) {
      return { ...base, status: "missing" };
    }
    if (closed) {
      return { ...base, status: "unavailable" };
    }
    if (entry.failure) {
      return { ...base, status: entry.failure.status };
    }
    if (entry.initializing) {
      return { ...base, status: "initializing" };
    }
    if (entry.ready) {
      const staleAgeMs = now() - (entry.lastActivityAt ?? now());
      if (staleAgeMs > staleAfterMs) {
        return { ...base, status: "stale", staleAgeMs };
      }
      return { ...base, status: "ready" };
    }
    // Idle: never spawned, or awaiting a budgeted respawn after a crash. The binary lookup is
    // cached per entry (a stat + PATH walk per snapshot would punish /doctor and lsp_status);
    // acquire refreshes it, and a crash or failed spawn invalidates it.
    if (!entry.commandResolved) {
      entry.command = adapter.resolveCommand(entry.root);
      entry.commandResolved = true;
    }
    return entry.command ? { ...base, status: "configured" } : { ...base, status: "unavailable" };
  };

  const doClose = async (): Promise<void> => {
    closed = true;
    await Promise.all([...entries.values()].map((entry) => entry.client?.shutdown()));
  };

  return {
    acquire,
    request,
    status: (workspaceRoot) => statusOf(ensureEntry(workspaceRoot)),
    statusSnapshot: () => {
      ensureEntry(defaultRoot); // the default root is always visible, touched or not
      return [...entries.values()].map(statusOf);
    },
    close: () => {
      closePromise ??= doClose();
      return closePromise;
    },
  };
}
