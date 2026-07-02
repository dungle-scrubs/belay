import { clipLine } from "@host/tools/shared";
import { type HookDecision, parseHookDecision } from "./decision";
import { redactHookText } from "./redact";
import type { HookExecution } from "./runner";
import type { HookTrustStatus } from "./trust";

/**
 * The hook OUTCOME model (plan 25 M4, D-007): what one hook run means to the turn. Exactly two
 * kinds - a structured `decision` (parsed from a SUCCESSFUL run's stdout; deny/halt block) or
 * a `diagnostic` (observable, NEVER blocking: it surfaces through events/Doctor while the turn
 * proceeds). Command failure, invalid JSON, and timeout are diagnostics BY DEFAULT - a hook
 * only blocks by succeeding and saying so - and a failed command's stdout is untrusted, so a
 * deny printed by a crashing hook is still command_failed. A SILENT success (exit 0, empty
 * stdout) is an implicit allow (25 M5): the observe-only hook shape gates nothing. This is a plain result union rather
 * than a Data.TaggedError channel on purpose: under D-007 none of these outcomes is an error a
 * caller branches on with catch - every variant is ordinary data on the happy path. Diagnostic
 * details quote hook output, so they are redacted (D-009) and bounded.
 *
 * Responsible for: the decision/diagnostic outcome union, deriving it from an execution or a
 * trust status, and the blocking predicate.
 * Not for: running hooks (./runner), parsing stdout (./decision), or counters (./stats).
 */

/** Why a hook run yielded no usable decision. Every reason is observable and non-blocking. */
export type HookDiagnosticReason =
  | "command_failed"
  | "invalid_json"
  | "invalid_decision"
  | "timeout"
  | "unapproved"
  | "trust_changed"
  | "missing_script";

export interface HookDecisionOutcome {
  readonly kind: "decision";
  readonly decision: HookDecision;
}

export interface HookDiagnosticOutcome {
  readonly kind: "diagnostic";
  readonly reason: HookDiagnosticReason;
  /** Redacted (D-009) and bounded to one displayable line. */
  readonly detail: string;
}

export type HookOutcome = HookDecisionOutcome | HookDiagnosticOutcome;

/** A diagnostic detail stays one bounded line; full output lives in the redacted execution log. */
export const MAX_HOOK_DIAGNOSTIC_DETAIL_CHARS = 500;

/** Derives the outcome of one completed execution. Pure; never throws (D-007). */
export function hookExecutionOutcome(execution: HookExecution): HookOutcome {
  if (execution.timedOut) {
    return diagnostic(
      "timeout",
      `hook timed out after ${execution.durationMs}ms (killed with ${execution.signal ?? "SIGTERM"})`,
    );
  }
  if (execution.spawnError !== undefined) {
    return diagnostic("command_failed", `command could not start: ${execution.spawnError}`);
  }
  if (execution.exitCode !== 0) {
    const death =
      execution.exitCode !== null
        ? `exited with code ${execution.exitCode}`
        : `was killed by ${execution.signal ?? "an unknown signal"}`;
    const stderrTail = execution.stderr.text.trim();
    return diagnostic(
      "command_failed",
      `command ${death}${stderrTail ? `; stderr: ${stderrTail}` : ""}`,
    );
  }

  if (execution.stdout.text.trim().length === 0) {
    // Silent success is implicit allow (25 M5): exit 0 with no stdout is the observe-only hook
    // shape (a logger/recorder that gates nothing). Demanding a JSON verb here would turn every
    // such hook into a per-call diagnostic; anything non-empty must still parse as a decision.
    return { kind: "decision", decision: { decision: "allow" } };
  }
  const parsed = parseHookDecision(execution.stdout.text);
  if (!parsed.ok) {
    return diagnostic(parsed.reason, parsed.detail);
  }
  return { kind: "decision", decision: parsed.decision };
}

/**
 * The trust gate's diagnostic projection (D-006): undefined for an approved hook (it may run),
 * otherwise the diagnostic that explains why it did not - reported, never blocking.
 */
export function hookTrustOutcome(status: HookTrustStatus): HookDiagnosticOutcome | undefined {
  switch (status) {
    case "approved":
      return undefined;
    case "unapproved":
      return diagnostic("unapproved", "hook is not approved; approve it to enable execution");
    case "changed":
      return diagnostic(
        "trust_changed",
        "hook config or referenced scripts changed since approval; re-approval required",
      );
    case "missing-script":
      return diagnostic("missing_script", "the hook's command script does not exist");
  }
}

/** Whether an outcome blocks the gated action: ONLY an explicit deny/halt decision (D-007). */
export function isBlockingHookOutcome(outcome: HookOutcome): boolean {
  return outcome.kind === "decision" && outcome.decision.decision !== "allow";
}

function diagnostic(reason: HookDiagnosticReason, detail: string): HookDiagnosticOutcome {
  return {
    kind: "diagnostic",
    reason,
    detail: clipLine(redactHookText(detail), MAX_HOOK_DIAGNOSTIC_DETAIL_CHARS),
  };
}
