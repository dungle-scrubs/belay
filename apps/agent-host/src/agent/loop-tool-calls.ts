/**
 * Responsible for: the agent loop's pure per-tool-call helpers - composing a guardrail decision
 * onto the model-facing result (guardedToolResult), rendering PreToolUse hook outcomes at the
 * boundary (parsedToolInput, hookBlockedResult, hookHaltStop), the trailing-announcement
 * heuristic (looksUnfinished), and partitioning a step's tool batch into concurrent-read /
 * serial-barrier segments (partitionToolCalls).
 * Not for: executing tools or dispatching the segments - the loop (loop.ts) owns that - or
 * hook dispatch semantics (@host/hooks/runtime).
 */

import type { TurnStop } from "@belay/session";
import type { PreToolUseOutcome } from "@host/hooks/runtime";
import type { ToolCall } from "@host/providers";
import { READ_ONLY_TOOLS } from "@host/tools";
import type { GuardrailDecision } from "./tool-guardrails";

/**
 * Composes a guardrail decision onto the model-facing tool result (M4/M6 / D-007). A `warn` appends
 * the action-oriented guidance after the raw result, so the model both keeps the output and reads the
 * advice to change approach. A `block` (opt-in hard stop) SUBSTITUTES the synthetic, retryable
 * guidance for the repeated output: the tool still executed (D-003), but its stale repeat is withheld
 * so the model stops re-reading it and changes course; the turn continues normally toward synthesis or
 * a typed terminal stop. Any other action returns the raw result unchanged. The guidance names only the
 * tool and a count - never raw arguments or output - so it is safe on the tool result; the redacted
 * guardrail event (M5) is the separate telemetry surface.
 */
export function guardedToolResult(rawResult: string, decision: GuardrailDecision): string {
  if (decision.action === "warn" && decision.guidance) {
    return `${rawResult}\n\n${decision.guidance}`;
  }
  if (decision.action === "block" && decision.guidance) {
    return decision.guidance;
  }
  return rawResult;
}

/**
 * The tool call's arguments as the PreToolUse payload's `toolInput` (25 M5, D-003): the parsed
 * object when the raw JSON parses (an empty string is the empty object, matching the executor),
 * else the raw string verbatim - a hook should see exactly what the tool boundary would.
 */
export function parsedToolInput(argsJson: string): unknown {
  try {
    return JSON.parse(argsJson || "{}");
  } catch {
    return argsJson;
  }
}

/** Names the blocking hook + reason in one bounded clause, shared by the result/stop renderers. */
function hookBlockClause(outcome: PreToolUseOutcome): string {
  const hook = outcome.hook ?? "unknown";
  return `PreToolUse hook "${hook}"${outcome.reason ? `: ${outcome.reason}` : ""}`;
}

/**
 * The model-facing result of a hook-blocked tool call (25 M5, D-003): error-shaped (so guardrail
 * failure tracking sees a repeated denial) and explicit that the tool DID NOT run, naming the
 * hook and its stated reason. A halt gets the same paired result so the assistant's tool_call
 * never dangles without a tool message, even though the turn then terminates.
 */
export function hookBlockedResult(outcome: PreToolUseOutcome): string {
  if (outcome.decision === "halt") {
    return `error: halted by ${hookBlockClause(outcome)} - the tool was not executed and the turn was stopped.`;
  }
  return `error: denied by ${hookBlockClause(outcome)} - the tool was not executed. Change your approach; repeating the same call will be denied again.`;
}

/**
 * The terminal stop a PreToolUse halt carries onto the turn completion (25 M5): the same
 * `TurnStop` mechanism the budget/stall pauses use, with the typed `hook_halt` cause
 * (a KnownTurnStopCause) and the hook's visible reason as summary.
 */
export function hookHaltStop(outcome: PreToolUseOutcome, steps: number): TurnStop {
  return {
    cause: "hook_halt",
    action: "paused",
    summary: `Halted by ${hookBlockClause(outcome)}.`,
    steps,
  };
}

/**
 * Appends the dispatch's bounded context notes to the model-facing result (25 M6, D-003), each
 * attributed to its hook so the model (and the transcript) can tell hook guidance from real
 * tool output. The result stays primary - notes ride below it. Each note was already capped at
 * decision parse, so a hook cannot flood the result body.
 */
export function withHookContexts(result: string, outcome: PreToolUseOutcome | null): string {
  if (!outcome || outcome.contexts.length === 0) {
    return result;
  }
  const notes = outcome.contexts.map((note) => `[hook ${note.hook}]: ${note.context}`).join("\n");
  return `${result}\n\n${notes}`;
}

/**
 * Applies the dispatch's allowlist-validated field rewrites onto the call's raw argument JSON
 * (25 M6, D-003), producing the argument string the executor decodes - so a rewritten value
 * faces the tool's NORMAL schema validation, exactly like a model-authored argument. No
 * rewrite (or un-mergeable original args, which the executor will reject anyway) returns the
 * original string unchanged.
 */
export function applyHookUpdatedInput(argsJson: string, outcome: PreToolUseOutcome | null): string {
  const updated = outcome?.updatedInput;
  if (!updated || Object.keys(updated).length === 0) {
    return argsJson;
  }
  const parsed = parsedToolInput(argsJson);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return argsJson;
  }
  return JSON.stringify({ ...(parsed as Record<string, unknown>), ...updated });
}

/**
 * Heuristic: did the model END a turn by ANNOUNCING an imminent action without calling a tool?
 * A weaker model sometimes trails off ("Let me continue reading the remaining files:") and stops
 * instead of emitting the next tool batch, which the loop would otherwise accept as a final answer.
 * Deliberately conservative - it only fires on a clear trailing announcement (a dangling colon, or a
 * closing "let me read…/I'll continue…" clause), so a genuine final answer is never mistaken for one.
 * Worst case on a false positive is one wasted nudge step, bounded to once per turn.
 */
export function looksUnfinished(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(":")) {
    return true; // "...let me read these files:" - about to list/act, then stopped
  }
  const tail = trimmed.slice(-160).toLowerCase();
  return /\b(let me|i'?ll|i will|now i|next,? i)\b.{0,90}\b(continue|read|look|check|explore|examine|review|proceed|start|dive|go through)\b[^.!?]*$/.test(
    tail,
  );
}

/** One ordered segment of a step's tool batch: a maximal run of consecutive read-only calls
 *  (run concurrently) OR a single mutating call (a serial barrier). Each entry keeps the call's
 *  original index so its result commits to the right `conversation` slot in CALL order. */
export type ToolSegment = ReadonlyArray<{ readonly call: ToolCall; readonly index: number }>;

/**
 * Partitions a step's tool batch into ordered segments for concurrent dispatch (D-050).
 * Consecutive read-only calls (per `READ_ONLY_TOOLS`) coalesce into one maximal run; every
 * mutating call breaks the run and forms its own singleton barrier. Segment order preserves
 * emission order, so a mutating call still executes in place relative to the reads around it.
 */
export function partitionToolCalls(calls: readonly ToolCall[]): readonly ToolSegment[] {
  const segments: { call: ToolCall; index: number }[][] = [];
  let run: { call: ToolCall; index: number }[] | null = null;
  calls.forEach((call, index) => {
    if (READ_ONLY_TOOLS.has(call.name)) {
      if (!run) {
        run = [];
        segments.push(run);
      }
      run.push({ call, index });
    } else {
      // A mutating call is its own barrier and ends any open read run.
      segments.push([{ call, index }]);
      run = null;
    }
  });
  return segments;
}
