import { asMaybeString, asOptRecord, oneOf } from "./coerce";

/**
 * The `tool_script` V2 CONTRACT (plan 16, M1). `tool_script` is a normal model-facing tool for bounded,
 * READ-ONLY batch analysis: the model writes a short TypeScript script that orchestrates many read/retrieval
 * bridge calls and returns a compact structured result. This module owns the pure protocol/read-model - the
 * request shape, named toolsets, per-run budgets, the typed failure-class vocabulary, the bridge-call audit
 * summary, and the result read model - shared by the host runner (which enforces it out-of-process) and the
 * web transcript/detail views.
 *
 * PROVENANCE (D-002): V1 ran the script IN-PROCESS via `AsyncFunction` with `process`/`Bun`/`require`/`fetch`
 * shadowed, allowed only the `safe_read` toolset, and reported four failure kinds (timeout, cancelled,
 * runtime_error, syntax_error). V2 preserves that product shape but the in-process boundary is provenance
 * ONLY, not the V2 safety boundary: V2 runs the script in a deny-first child process and adds the
 * sandbox/bridge/budget failure classes below. Retryability is refined from V1 (which marked everything
 * retryable) to reflect which failures a fresh attempt could actually clear.
 */

/** The named read-only capability toolsets a script may request. `safe_read` is the first-cut default; the
 *  others grow the bridge deliberately without turning it into ambient access. */
export type ToolScriptToolset = "safe_read" | "retrieval" | "docs_read" | "media_read";

export const TOOL_SCRIPT_TOOLSETS: readonly ToolScriptToolset[] = [
  "safe_read",
  "retrieval",
  "docs_read",
  "media_read",
];

/**
 * The concrete read-only bridge tools each toolset exposes (V2). All route through the normal host tool
 * registry + metadata policy - never ambient access. Some are empty until their own plans land
 * (source_recall/code_search, archive_read/video_inspect); mutation/shell tools are never listed.
 */
export const TOOLSET_TOOLS: Readonly<Record<ToolScriptToolset, readonly string[]>> = {
  safe_read: ["read", "glob", "grep", "ast_grep"],
  retrieval: ["session_recall"],
  docs_read: ["docs", "web_fetch"],
  media_read: [],
};

/** Per-run budgets, all host-enforced at the bridge + final-output boundary. */
export interface ToolScriptBudgets {
  readonly timeoutMs: number;
  /** Max total bridge calls. */
  readonly maxBridgeCalls: number;
  /** Max bytes of a single bridge call's output before it is summarized to an artifact ref. */
  readonly maxToolOutputBytes: number;
  /** Max bytes of the final result JSON. */
  readonly maxResultBytes: number;
}

export const DEFAULT_TOOL_SCRIPT_BUDGETS: ToolScriptBudgets = {
  timeoutMs: 30_000,
  maxBridgeCalls: 100,
  maxToolOutputBytes: 2048,
  maxResultBytes: 8000,
};

/** The V2 tool_script request. `language` is fixed to TypeScript; `permissions.toolsets` gates the bridge. */
export interface ToolScriptRequest {
  readonly language: "typescript";
  readonly script: string;
  readonly permissions: { readonly toolsets: readonly ToolScriptToolset[] };
  readonly budgets: ToolScriptBudgets;
}

/**
 * The typed failure classes. The first four are V1 provenance; the rest are V2 additions for the
 * out-of-process sandbox + host-bridge policy + budget enforcement.
 */
export type ToolScriptFailureClass =
  | "timeout"
  | "cancelled"
  | "syntax_error"
  | "runtime_error"
  | "validation"
  | "sandbox_launch"
  | "bridge_denied"
  | "bridge_failed"
  | "output_too_large"
  | "budget_exhausted";

export const TOOL_SCRIPT_FAILURE_CLASSES: readonly ToolScriptFailureClass[] = [
  "timeout",
  "cancelled",
  "syntax_error",
  "runtime_error",
  "validation",
  "sandbox_launch",
  "bridge_denied",
  "bridge_failed",
  "output_too_large",
  "budget_exhausted",
];

/** Failure classes a fresh attempt could clear (transient) vs deterministic script/policy errors. */
const RETRYABLE_FAILURES: ReadonlySet<ToolScriptFailureClass> = new Set([
  "timeout",
  "cancelled",
  "bridge_failed",
  "sandbox_launch",
]);

/** Whether retrying the same script/permissions could succeed. Deterministic errors (validation, syntax,
 *  runtime, bridge_denied, output_too_large, budget_exhausted) are NOT retryable. */
export function isRetryableFailure(failureClass: ToolScriptFailureClass): boolean {
  return RETRYABLE_FAILURES.has(failureClass);
}

/** The audit summary of ONE bridge call - never the raw input/output content. */
export interface ToolScriptBridgeCall {
  readonly tool: string;
  /** Hash of the call input (correlates repeat calls without carrying the raw args). */
  readonly inputHash: string;
  /** Bytes of the (possibly summarized) output. */
  readonly outputBytes: number;
  readonly status: "ok" | "denied" | "failed";
  readonly durationMs?: number;
  readonly failureClass?: ToolScriptFailureClass;
}

/** Budget counters surfaced to transcript/detail. */
export interface ToolScriptCounters {
  readonly bridgeCalls: number;
  readonly outputBytes: number;
  readonly durationMs: number;
}

/** How the child runner was isolated. Refined in M2/M4; `none` means no OS sandbox was applied. */
export type SandboxMode = "sandbox-exec" | "safehouse" | "child-process" | "none";

export const SANDBOX_MODES: readonly SandboxMode[] = [
  "sandbox-exec",
  "safehouse",
  "child-process",
  "none",
];

interface ToolScriptResultBase {
  readonly bridgeCalls: readonly ToolScriptBridgeCall[];
  readonly counters: ToolScriptCounters;
  readonly sandboxMode: SandboxMode;
}

/** The V2 tool_script result read model (discriminated by `status`). */
export type ToolScriptResult =
  | (ToolScriptResultBase & { readonly status: "completed"; readonly result: unknown })
  | (ToolScriptResultBase & {
      readonly status: "failed";
      readonly failureClass: ToolScriptFailureClass;
      readonly retryable: boolean;
      readonly error: string;
    });

/** Whether a value is one of the known toolsets. */
function isToolset(v: unknown): v is ToolScriptToolset {
  return typeof v === "string" && (TOOL_SCRIPT_TOOLSETS as readonly string[]).includes(v);
}

export type ValidateResult =
  | { readonly ok: true; readonly request: ToolScriptRequest }
  | { readonly ok: false; readonly failureClass: "validation"; readonly error: string };

/**
 * Validates + normalizes a raw tool_script request BEFORE any execution: the language must be TypeScript,
 * the script a non-empty string, and every requested toolset a known read-only toolset (a non-empty set).
 * Budgets default when omitted. A bad request is a non-retryable `validation` failure, rejected before a
 * child is ever launched.
 */
export function validateToolScriptRequest(raw: unknown): ValidateResult {
  const o = asOptRecord(raw);
  const fail = (error: string): ValidateResult => ({
    ok: false,
    failureClass: "validation",
    error,
  });
  if (!o) {
    return fail("request must be an object");
  }
  if (o.language !== "typescript") {
    return fail(`unsupported language ${String(o.language)} (only typescript)`);
  }
  if (typeof o.script !== "string" || o.script.trim().length === 0) {
    return fail("script must be a non-empty string");
  }
  const permissions = asOptRecord(o.permissions);
  const rawToolsets = permissions?.toolsets;
  if (!Array.isArray(rawToolsets) || rawToolsets.length === 0) {
    return fail("permissions.toolsets must be a non-empty array");
  }
  const toolsets: ToolScriptToolset[] = [];
  for (const t of rawToolsets) {
    if (!isToolset(t)) {
      return fail(`unknown toolset ${String(t)}`);
    }
    if (!toolsets.includes(t)) {
      toolsets.push(t);
    }
  }
  const budgets = normalizeBudgets(asOptRecord(o.budgets));
  return {
    ok: true,
    request: { language: "typescript", script: o.script, permissions: { toolsets }, budgets },
  };
}

/** Fills any omitted budget from the defaults, clamping each to a positive number. */
function normalizeBudgets(raw: Record<string, unknown> | undefined): ToolScriptBudgets {
  const num = (key: keyof ToolScriptBudgets): number => {
    const v = raw?.[key];
    return typeof v === "number" && v > 0 ? v : DEFAULT_TOOL_SCRIPT_BUDGETS[key];
  };
  return {
    timeoutMs: num("timeoutMs"),
    maxBridgeCalls: num("maxBridgeCalls"),
    maxToolOutputBytes: num("maxToolOutputBytes"),
    maxResultBytes: num("maxResultBytes"),
  };
}

function decodeBridgeCall(v: unknown): ToolScriptBridgeCall | null {
  const o = asOptRecord(v);
  if (!o || typeof o.tool !== "string") {
    return null;
  }
  return {
    tool: o.tool,
    inputHash: asMaybeString(o.inputHash) ?? "",
    outputBytes: typeof o.outputBytes === "number" ? o.outputBytes : 0,
    status: oneOf(["ok", "denied", "failed"] as const, o.status, "ok"),
    ...(typeof o.durationMs === "number" ? { durationMs: o.durationMs } : {}),
    ...(TOOL_SCRIPT_FAILURE_CLASSES.includes(o.failureClass as ToolScriptFailureClass)
      ? { failureClass: o.failureClass as ToolScriptFailureClass }
      : {}),
  };
}

function decodeCounters(v: unknown): ToolScriptCounters {
  const o = asOptRecord(v);
  const num = (k: string): number => (typeof o?.[k] === "number" ? (o[k] as number) : 0);
  return {
    bridgeCalls: num("bridgeCalls"),
    outputBytes: num("outputBytes"),
    durationMs: num("durationMs"),
  };
}

/** Permissively decodes a tool_script result from untrusted JSON, or null when it is not one. */
export function decodeToolScriptResult(v: unknown): ToolScriptResult | null {
  const o = asOptRecord(v);
  if (!o || (o.status !== "completed" && o.status !== "failed")) {
    return null;
  }
  const bridgeCalls = Array.isArray(o.bridgeCalls)
    ? o.bridgeCalls.map(decodeBridgeCall).filter((c): c is ToolScriptBridgeCall => c !== null)
    : [];
  const base = {
    bridgeCalls,
    counters: decodeCounters(o.counters),
    sandboxMode: oneOf(SANDBOX_MODES, o.sandboxMode, "none"),
  };
  if (o.status === "completed") {
    return { status: "completed", result: o.result, ...base };
  }
  const failureClass = oneOf(TOOL_SCRIPT_FAILURE_CLASSES, o.failureClass, "runtime_error");
  return {
    status: "failed",
    failureClass,
    retryable: typeof o.retryable === "boolean" ? o.retryable : isRetryableFailure(failureClass),
    error: asMaybeString(o.error) ?? "",
    ...base,
  };
}
