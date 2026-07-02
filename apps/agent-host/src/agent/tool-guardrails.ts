import { createHash } from "node:crypto";

/**
 * Tool-call guardrails: a pure, per-turn controller (D-002). It observes tool calls and their
 * results, tracks REDACTED fingerprints and counters keyed by tool name plus a canonical argument
 * fingerprint, and returns a typed {@link GuardrailDecision}. It does not execute tools, mutate
 * conversation history, publish events, read global config, persist lessons, or decide permissions -
 * `runAgent` owns every runtime effect (D-007). The controller is the single place that classifies a
 * repeating tool path, so the loop integration stays a thin "append guidance / emit event" layer.
 *
 * Two crucial constraints shape the state (Architecture key constraints):
 *   - No output cache (D-003): only short fingerprints + counters are stored, never raw args or raw
 *     output, and a prior result is never replayed or used to skip execution.
 *   - Same input can change over time (D-004): a repeated argument fingerprint is only a signal;
 *     no-progress detection requires a READ-ONLY tool to return the SAME result fingerprint repeatedly.
 *
 * Responsible for: classifying repeating tool calls into typed allow/warn/block guardrail
 * decisions from redacted fingerprints.
 * Not for: executing tools or applying the decision - runAgent (loop.ts) owns runtime effects.
 */

/** The decision verb the loop acts on. `allow` proceeds; `warn` appends model guidance; `block`
 *  substitutes a synthetic retryable result (opt-in hard stop). `halt` is reserved for a future
 *  terminal escalation - it rounds out the redacted observability vocabulary (D-008) and is accepted
 *  by the event surface, but the controller does not emit it in this cut. */
export type GuardrailAction = "allow" | "warn" | "block" | "halt";

/** Why a non-`allow` decision fired. `ok` accompanies every `allow`. */
export type GuardrailReason = "ok" | "repeated_failure" | "no_progress";

/**
 * One typed, REDACTED decision for an observed tool call (D-005, D-008). Carries the tool name, the
 * decision action + reason code, the relevant repeat count, and short fingerprints only - never raw
 * arguments or raw output. `guidance` is the model-facing text the loop appends for `warn`/`block`;
 * it names the tool and count (both already in the redacted surface) but never a path, query, command,
 * or output value.
 */
export interface GuardrailDecision {
  readonly action: GuardrailAction;
  readonly reason: GuardrailReason;
  readonly tool: string;
  /** The relevant repeat count: the failure streak (repeated_failure), the same-result streak
   *  (no_progress), or the total call count for this signature (allow). */
  readonly count: number;
  readonly argsFingerprint: string;
  /** The read-only result fingerprint, present on a no-progress decision. */
  readonly resultFingerprint?: string;
  /** The failure-result fingerprint, present on a repeated-failure decision. */
  readonly failureFingerprint?: string;
  /** Action-oriented model guidance appended by the loop for `warn`/`block`; absent for `allow`. */
  readonly guidance?: string;
}

/** Thresholds for the controller. Injected (never read from global config, D-002) so a turn or a
 *  test can tune them deterministically. */
export interface GuardrailConfig {
  /** Consecutive identical failures of one signature before a `warn`. */
  readonly failureWarnAt: number;
  /** Consecutive identical read-only results of one signature before a `warn`. */
  readonly noProgressWarnAt: number;
  /** Whether opt-in hard stops are enabled (synthetic blocked results). Off by default (D-001). */
  readonly hardStop: boolean;
  /** Consecutive identical failures / results before a `block` (only when `hardStop`). */
  readonly hardStopAt: number;
}

export const DEFAULT_GUARDRAIL_CONFIG: GuardrailConfig = {
  failureWarnAt: 3,
  noProgressWarnAt: 3,
  hardStop: false,
  hardStopAt: 5,
};

/** A redacted snapshot of one (tool, args-fingerprint) signature's state, for inspectable
 *  observability. Contains only counters and short fingerprints - never raw args or raw output. */
export interface GuardrailSnapshotEntry {
  readonly tool: string;
  readonly argsFingerprint: string;
  readonly calls: number;
  readonly failures: number;
  readonly sameResults: number;
  readonly lastFailureFingerprint?: string;
  readonly lastResultFingerprint?: string;
}

export interface ToolGuardrails {
  /** Observe one completed tool call (its raw args JSON + raw result string) and return a typed,
   *  redacted decision. The raw inputs are fingerprinted and discarded; only counters + fingerprints
   *  are retained. */
  observe(tool: string, argsJson: string, result: string): GuardrailDecision;
  /** A redacted view of the controller's internal state (inspectable observability, D-008). */
  snapshot(): readonly GuardrailSnapshotEntry[];
}

const FINGERPRINT_LENGTH = 12;

function sha(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, FINGERPRINT_LENGTH);
}

/** Recursively sorts object keys so two structurally-equal argument objects canonicalize identically. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * A stable, short fingerprint of a tool call's raw argument JSON. Objects are canonicalized with
 * sorted keys so `{a,b}` and `{b,a}` collapse to one signature; a non-JSON or otherwise un-parseable
 * argument string falls back to hashing the raw text verbatim (never throws). An empty argument
 * string is treated as the empty object, matching the executor's `JSON.parse(args || "{}")`.
 */
export function argsFingerprint(argsJson: string): string {
  let canonical: string;
  try {
    canonical = JSON.stringify(canonicalize(JSON.parse(argsJson || "{}")));
  } catch {
    canonical = argsJson;
  }
  return sha(canonical);
}

/** A short fingerprint of a tool result, used for read-only no-progress detection. */
export function resultFingerprint(result: string): string {
  return sha(result);
}

/**
 * A short fingerprint of a FAILURE result, used for repeated-exact-failure detection. The leading
 * `error:` envelope is stripped before hashing, so two renderings of the same underlying failure
 * collapse to one fingerprint even if the envelope wording shifts.
 */
export function failureFingerprint(result: string): string {
  return sha(result.trim().replace(/^error:\s*/i, ""));
}

/** Trevor's local tool-failure convention: the executor renders every failure as an `error: …` line. */
export function isFailureResult(result: string): boolean {
  return /^error:/i.test(result.trimStart());
}

interface SignatureState {
  readonly tool: string;
  readonly argsFingerprint: string;
  calls: number;
  failures: number;
  lastFailureFingerprint?: string;
  sameResults: number;
  lastResultFingerprint?: string;
}

function toPredicate(
  readOnly: ReadonlySet<string> | ((name: string) => boolean),
): (name: string) => boolean {
  return typeof readOnly === "function" ? readOnly : (name) => readOnly.has(name);
}

/**
 * The action-oriented model guidance the loop appends for a non-`allow` decision (M4). Each names the
 * tool and the repeat count - both already in the redacted surface - and steers the model toward a
 * DIFFERENT input or strategy. None of them tell the model to stop using tools entirely (M4 REFACTOR);
 * a guarded path should change approach, not abandon tools.
 */
function warnFailureGuidance(state: SignatureState): string {
  return (
    `Guardrail: this "${state.tool}" call has failed ${state.failures} times in a row with the same ` +
    "arguments. Re-running it as-is will fail again - change the arguments, fix the underlying cause, " +
    "or try a different tool or approach."
  );
}

function blockFailureGuidance(state: SignatureState): string {
  return (
    `Guardrail: this exact "${state.tool}" call has failed ${state.failures} times with no change, so ` +
    "its repeated output is withheld. Change the arguments, the tool, or the underlying cause before " +
    "calling it again."
  );
}

function warnNoProgressGuidance(state: SignatureState): string {
  return (
    `Guardrail: this "${state.tool}" call has returned an identical result ${state.sameResults} times. ` +
    "Re-running it will not surface new information - use the result you already have, or change the " +
    "query, path, or strategy to make progress."
  );
}

function blockNoProgressGuidance(state: SignatureState): string {
  return (
    `Guardrail: this exact "${state.tool}" call keeps returning the same result (${state.sameResults} ` +
    "times), so its repeated output is withheld. Use the result you already have or change your approach."
  );
}

/**
 * Builds a per-turn guardrail controller. `readOnly` is the registry-derived purity source (D-006) -
 * a set or predicate of read-only tool names; only those tools participate in same-result no-progress
 * detection. Tools omitted are treated as dynamic / mutating barriers and excluded by default.
 */
export function createToolGuardrails(opts: {
  readonly readOnly: ReadonlySet<string> | ((name: string) => boolean);
  readonly config?: Partial<GuardrailConfig>;
}): ToolGuardrails {
  const config: GuardrailConfig = { ...DEFAULT_GUARDRAIL_CONFIG, ...opts.config };
  const isReadOnly = toPredicate(opts.readOnly);
  const signatures = new Map<string, SignatureState>();

  const stateFor = (tool: string, argsFp: string): SignatureState => {
    const key = `${tool}::${argsFp}`;
    let state = signatures.get(key);
    if (!state) {
      state = { tool, argsFingerprint: argsFp, calls: 0, failures: 0, sameResults: 0 };
      signatures.set(key, state);
    }
    return state;
  };

  const allow = (tool: string, state: SignatureState): GuardrailDecision => ({
    action: "allow",
    reason: "ok",
    tool,
    count: state.calls,
    argsFingerprint: state.argsFingerprint,
  });

  // A repeated EXACT failure of one signature (D-001): warn after the configured streak; block only
  // when opt-in hard stops are enabled and the higher threshold is met. Repeated failures are
  // advisory by default - the same args can recover after a transient fault, so a later success
  // clears this state below.
  const decideFailure = (state: SignatureState, failFp: string): GuardrailDecision => {
    const base = {
      tool: state.tool,
      count: state.failures,
      argsFingerprint: state.argsFingerprint,
      failureFingerprint: failFp,
    } as const;
    if (config.hardStop && state.failures >= config.hardStopAt) {
      return {
        action: "block",
        reason: "repeated_failure",
        ...base,
        guidance: blockFailureGuidance(state),
      };
    }
    if (state.failures >= config.failureWarnAt) {
      return {
        action: "warn",
        reason: "repeated_failure",
        ...base,
        guidance: warnFailureGuidance(state),
      };
    }
    return { action: "allow", reason: "ok", ...base };
  };

  // Read-only same-args SAME-result no progress (D-004): only a read-only tool returning an identical
  // result fingerprint repeatedly counts. A changed result fingerprint resets the streak (handled in
  // observe), so a dynamic-but-marked-read-only tool that genuinely returns new data never trips this.
  const decideNoProgress = (state: SignatureState, resultFp: string): GuardrailDecision => {
    const base = {
      tool: state.tool,
      count: state.sameResults,
      argsFingerprint: state.argsFingerprint,
      resultFingerprint: resultFp,
    } as const;
    if (config.hardStop && state.sameResults >= config.hardStopAt) {
      return {
        action: "block",
        reason: "no_progress",
        ...base,
        guidance: blockNoProgressGuidance(state),
      };
    }
    if (state.sameResults >= config.noProgressWarnAt) {
      return {
        action: "warn",
        reason: "no_progress",
        ...base,
        guidance: warnNoProgressGuidance(state),
      };
    }
    return { action: "allow", reason: "ok", ...base };
  };

  return {
    observe(tool, argsJson, result): GuardrailDecision {
      const argsFp = argsFingerprint(argsJson);
      const state = stateFor(tool, argsFp);
      state.calls += 1;

      if (isFailureResult(result)) {
        const failFp = failureFingerprint(result);
        state.failures = failFp === state.lastFailureFingerprint ? state.failures + 1 : 1;
        state.lastFailureFingerprint = failFp;
        // A failure is not a read-only progress signal; drop any same-result streak so a later
        // success starts its no-progress count fresh.
        state.sameResults = 0;
        state.lastResultFingerprint = undefined;
        return decideFailure(state, failFp);
      }

      // A same-args SUCCESS clears the exact-failure state for this signature (D-001): a transient
      // failure that later resolves with identical args must not keep warning.
      state.failures = 0;
      state.lastFailureFingerprint = undefined;

      if (isReadOnly(tool)) {
        const resultFp = resultFingerprint(result);
        state.sameResults = resultFp === state.lastResultFingerprint ? state.sameResults + 1 : 1;
        state.lastResultFingerprint = resultFp;
        return decideNoProgress(state, resultFp);
      }

      // A dynamic / mutating tool is excluded from same-result no-progress detection (D-006): keep no
      // result streak for it, so its repeated identical output is never treated as a stall.
      state.sameResults = 0;
      state.lastResultFingerprint = undefined;
      return allow(tool, state);
    },
    snapshot(): readonly GuardrailSnapshotEntry[] {
      return [...signatures.values()].map((state) => ({
        tool: state.tool,
        argsFingerprint: state.argsFingerprint,
        calls: state.calls,
        failures: state.failures,
        sameResults: state.sameResults,
        ...(state.lastFailureFingerprint
          ? { lastFailureFingerprint: state.lastFailureFingerprint }
          : {}),
        ...(state.lastResultFingerprint
          ? { lastResultFingerprint: state.lastResultFingerprint }
          : {}),
      }));
    },
  };
}
