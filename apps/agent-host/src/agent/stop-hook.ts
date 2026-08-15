import type { TurnStop } from "@belay/session";
import { asRecord } from "@host/boot/decode";
import type { StopContext, StopOutcome, StopToolSummaryEntry } from "@host/hooks/runtime";
import type { ChatMessage } from "@host/providers/index";

/**
 * The turn side of the Stop hook seam (plan 25 M7/M8, D-004): the pure helpers publishTurn uses
 * to build a finalizing turn's Stop payload, render a halt onto the terminal completion, and
 * frame the ONE continuation pass a Stop context can request. The tool summary is deliberately
 * compact and cheap - per-tool call counts in first-appearance order plus the distinct `path`
 * arguments (the shared field name of the fs tools) when the call's JSON parses, capped per
 * tool - never raw arguments or outputs. It counts EXECUTED tools only: publishTurn records a
 * call at its non-skipped completion, so a hook-denied or halt-skipped call never inflates
 * "what the turn ran" (25 simplify C4). A halt rides the existing TurnStop mechanism with the
 * typed `hook_halt` cause, so the web transcript renders it (the stop note on
 * assistant.completed) with no extra event kinds. The continuation prompt cites each note's
 * hook (the withHookContexts attribution shape) and states the pass is tool-less -
 * model-context-only, per D-004.
 *
 * Responsible for: the Stop payload's tool-summary accumulation, the terminal-reason
 * projection, the halted-completion TurnStop, and the continuation-pass message framing.
 * Not for: dispatch semantics (@host/hooks/runtime) or the finalization wiring itself
 * (./turn).
 */

/** Touched-path cap per tool: enough to orient a hook, never a flood. */
const MAX_SUMMARY_FILES_PER_TOOL = 8;

/** Accumulates one turn's executed tool calls into the compact Stop-payload summary. */
export interface StopToolSummary {
  /** Records one EXECUTED tool call at completion: the name plus its raw argument JSON. */
  readonly record: (name: string, argsJson: string) => void;
  readonly snapshot: () => readonly StopToolSummaryEntry[];
}

/** A per-turn collector; publishTurn feeds it every non-skipped tool completion. */
export function createStopToolSummary(): StopToolSummary {
  const order: string[] = [];
  const counts = new Map<string, number>();
  const files = new Map<string, Set<string>>();
  return {
    record: (name, argsJson) => {
      if (!counts.has(name)) {
        order.push(name);
      }
      counts.set(name, (counts.get(name) ?? 0) + 1);

      const path = pathArgOf(argsJson);
      if (path !== undefined) {
        const touched = files.get(name) ?? new Set<string>();
        if (touched.size < MAX_SUMMARY_FILES_PER_TOOL) {
          touched.add(path);
        }
        files.set(name, touched);
      }
    },
    snapshot: () =>
      order.map((tool) => {
        const touched = files.get(tool);
        return {
          tool,
          count: counts.get(tool) ?? 0,
          ...(touched && touched.size > 0 ? { files: [...touched] } : {}),
        };
      }),
  };
}

/** The cheap touched-path derivation: the call's `path` argument when its JSON parses. */
function pathArgOf(argsJson: string): string | undefined {
  try {
    const path = asRecord(JSON.parse(argsJson || "{}"))?.path;
    return typeof path === "string" && path.length > 0 ? path : undefined;
  } catch {
    return undefined;
  }
}

/** The Stop payload's terminal reason: the turn's TurnStop cause, else "completed" (D-004). */
export function stopTerminalReason(stop: TurnStop | undefined): string {
  return stop?.cause ?? "completed";
}

/**
 * The visible halted-completion marker (25 M7): the same TurnStop mechanism budget pauses and
 * PreToolUse halts use, with the M5 `hook_halt` cause and the hook's stated reason as summary.
 * The completion itself still publishes (the turn ENDS - halt blocks "finalize as-is", never
 * wedges the run); the web renders this as the stop note on the assistant bubble today.
 */
export function stopHookHaltStop(outcome: StopOutcome): TurnStop {
  const hook = outcome.hook ?? "unknown";
  return {
    cause: "hook_halt",
    action: "paused",
    summary: `Completion halted by Stop hook "${hook}"${outcome.reason ? `: ${outcome.reason}` : ""}.`,
  };
}

/**
 * The continuation pass's conversation (25 M8): the turn's own history, the answer being
 * continued (skipped when the turn produced no text), and the hooks' attributed notes framed as
 * ONE user message that also states the pass's constraint - no tools, plain text. The notes use
 * the same `[hook <key>]: <note>` attribution as withHookContexts, so the model (and anyone
 * reading the transcript) can tell hook guidance from user intent.
 */
export function continuationMessages(
  history: readonly ChatMessage[],
  finalText: string,
  contexts: readonly StopContext[],
): ChatMessage[] {
  const notes = contexts.map((note) => `[hook ${note.hook}]: ${note.context}`).join("\n");
  return [
    ...history,
    ...(finalText.length > 0 ? [{ role: "assistant" as const, content: finalText }] : []),
    {
      role: "user",
      content:
        "A Stop hook reviewed your answer and asked for one continuation with this context:\n" +
        `${notes}\n` +
        "Address the context and give your complete final answer now, in plain text. " +
        "You cannot call tools.",
    },
  ];
}

/**
 * The budget-exhausted projection (25 M8, D-004): the re-dispatch outcome with the ignored
 * continuation request appended as a diagnostic, attributed to the first requesting hook - what
 * rides to `onStopOutcome` (the M9 seam) so the ignored ask stays observable.
 */
export function withContinuationExhausted(outcome: StopOutcome): StopOutcome {
  return {
    ...outcome,
    diagnostics: [
      ...outcome.diagnostics,
      {
        hook: outcome.contexts[0]?.hook ?? "unknown",
        reason: "continuation_exhausted",
        detail: "the one continuation pass for this run is spent; additional Stop context ignored",
      },
    ],
  };
}
