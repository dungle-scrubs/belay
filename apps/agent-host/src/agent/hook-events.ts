import {
  events,
  type HookDecisionEventName,
  type HookDecisionKind,
  type TrevorEventInput,
} from "@belay/session";
import { redactHookText } from "@host/hooks/redact";
import type { PreToolUseOutcome, StopOutcome } from "@host/hooks/runtime";
import { clipLine } from "@host/tools/shared";
import type { TurnHooks } from "./loop";

/**
 * The dispatch-outcome -> `hook.decision` event fold and the per-turn emitting wrapper (plan 25
 * M9, D-009). Emission policy: a plain allow is SILENT - one wire event per gated tool call
 * would drown the transcript, and the runtime's structured logs already record every decision -
 * while deny/halt (the blocks), context/updated_input (the bounded influence verbs, attributed
 * to their authoring hook), and a Stop continuation request always emit. Diagnostics emit
 * mapped onto the wire's diagnostic verbs (timeout/unapproved/trust_changed keep their names,
 * everything else is an `error` prefixed with its machine tag) and are DEDUPED per turn by
 * hook + verb, so an unapproved hook reads as one row per turn, not one per tool call. Every
 * wire reason is re-redacted and bounded here, so no caller can leak an unbounded hook string.
 *
 * Responsible for: folding PreToolUse/Stop dispatch outcomes into hook.decision event inputs
 * and wrapping a turn's TurnHooks so publishTurn emits them through Emit.
 * Not for: dispatch semantics (@host/hooks/runtime) or the Emit wiring itself (./turn).
 */

/** One bounded line per wire reason; the full detail stays in the redacted host logs. */
export const MAX_HOOK_EVENT_REASON_CHARS = 200;

/** The diagnostic reasons that keep their own wire verb; everything else folds to "error". */
const DIAGNOSTIC_VERBS: Readonly<Record<string, HookDecisionKind>> = {
  timeout: "timeout",
  unapproved: "unapproved",
  trust_changed: "trust_changed",
};

/** The wire verbs the per-turn wrapper dedupes (steady states, not per-call acts). */
const DEDUPED_VERBS: ReadonlySet<string> = new Set([
  "timeout",
  "error",
  "unapproved",
  "trust_changed",
]);

function bounded(text: string): string {
  return clipLine(redactHookText(text), MAX_HOOK_EVENT_REASON_CHARS);
}

function diagnosticEvent(
  runId: string,
  event: HookDecisionEventName,
  diagnostic: { readonly hook: string; readonly reason: string; readonly detail: string },
  toolName?: string,
): TrevorEventInput {
  return events.hookDecision({
    runId,
    hookId: diagnostic.hook,
    event,
    decision: DIAGNOSTIC_VERBS[diagnostic.reason] ?? "error",
    ...(toolName ? { toolName } : {}),
    reason: bounded(`${diagnostic.reason}: ${diagnostic.detail}`),
  });
}

/** Folds one PreToolUse dispatch outcome into its visible events; empty for a plain allow. */
export function preToolUseDecisionEvents(
  runId: string,
  toolName: string,
  outcome: PreToolUseOutcome,
): TrevorEventInput[] {
  const out: TrevorEventInput[] = [];
  for (const note of outcome.contexts) {
    out.push(
      events.hookDecision({
        runId,
        hookId: note.hook,
        event: "PreToolUse",
        decision: "context",
        toolName,
        reason: bounded(note.context),
      }),
    );
  }
  for (const hook of outcome.updatedInputHooks ?? []) {
    out.push(
      events.hookDecision({
        runId,
        hookId: hook,
        event: "PreToolUse",
        decision: "updated_input",
        toolName,
      }),
    );
  }
  if (outcome.decision !== "allow") {
    out.push(
      events.hookDecision({
        runId,
        hookId: outcome.hook ?? "",
        event: "PreToolUse",
        decision: outcome.decision,
        toolName,
        ...(outcome.reason ? { reason: bounded(outcome.reason) } : {}),
      }),
    );
  }
  for (const diagnostic of outcome.diagnostics) {
    out.push(diagnosticEvent(runId, "PreToolUse", diagnostic, toolName));
  }
  return out;
}

/**
 * Folds one Stop dispatch outcome into its visible events. A halt emits ONE halt row (its
 * context notes are dead - no continuation runs past a halt); an allow's contexts are the
 * continuation request and emit as `continuation` - unless this is the exhausted re-ask, whose
 * ignored contexts surface only through their `continuation_exhausted` diagnostic.
 */
export function stopDecisionEvents(runId: string, outcome: StopOutcome): TrevorEventInput[] {
  const out: TrevorEventInput[] = [];
  const exhausted = outcome.diagnostics.some((d) => d.reason === "continuation_exhausted");

  if (outcome.decision === "halt") {
    out.push(
      events.hookDecision({
        runId,
        hookId: outcome.hook ?? "",
        event: "Stop",
        decision: "halt",
        ...(outcome.reason ? { reason: bounded(outcome.reason) } : {}),
      }),
    );
  } else if (!exhausted) {
    for (const note of outcome.contexts) {
      out.push(
        events.hookDecision({
          runId,
          hookId: note.hook,
          event: "Stop",
          decision: "continuation",
          reason: bounded(note.context),
        }),
      );
    }
  }
  for (const diagnostic of outcome.diagnostics) {
    out.push(diagnosticEvent(runId, "Stop", diagnostic));
  }
  return out;
}

/**
 * Wraps a turn's hooks so every dispatch outcome ALSO emits its visible hook.decision events
 * through `publish` (publishTurn wires Emit here), composing with - never replacing - any
 * observer the caller already installed. Carries the per-turn diagnostic dedupe state, so it
 * must be built once per turn, not per call.
 */
export function withHookDecisionEvents(
  hooks: TurnHooks,
  runId: string,
  publish: (event: TrevorEventInput) => void,
): TurnHooks {
  const seenDiagnostics = new Set<string>();
  const emit = (input: TrevorEventInput): void => {
    const decision = String(input.payload.decision);
    if (DEDUPED_VERBS.has(decision)) {
      const key = `${String(input.payload.hookId)}|${decision}`;
      if (seenDiagnostics.has(key)) {
        return;
      }
      seenDiagnostics.add(key);
    }
    publish(input);
  };

  return {
    ...hooks,
    observers: {
      onOutcome: (report) => {
        hooks.observers?.onOutcome?.(report);
        for (const event of preToolUseDecisionEvents(runId, report.toolName, report.outcome)) {
          emit(event);
        }
      },
      onStopOutcome: (report) => {
        hooks.observers?.onStopOutcome?.(report);
        for (const event of stopDecisionEvents(runId, report.outcome)) {
          emit(event);
        }
      },
    },
  };
}
