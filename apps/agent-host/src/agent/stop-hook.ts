import type { StopOutcome, StopToolSummaryEntry } from "@host/hooks/runtime";
import type { TurnStop } from "@trevor/session";

/**
 * The turn side of the Stop hook seam (plan 25 M7, D-004): the pure helpers publishTurn uses to
 * build a finalizing turn's Stop payload and to render a halt onto the terminal completion. The
 * tool summary is deliberately compact and cheap - per-tool call counts in first-appearance
 * order plus the distinct `path` arguments (the shared field name of the fs tools) when the
 * call's JSON parses, capped per tool - never raw arguments or outputs. A halt rides the
 * existing TurnStop mechanism with the M5 `hook_halt` cause, so the web transcript renders it
 * today (the stop note on assistant.completed) with no protocol changes; M9 owns richer events.
 *
 * Responsible for: the Stop payload's tool-summary accumulation, the terminal-reason
 * projection, and the halted-completion TurnStop.
 * Not for: dispatch semantics (@host/hooks/runtime) or the finalization wiring itself
 * (./turn).
 */

/** Touched-path cap per tool: enough to orient a hook, never a flood. */
const MAX_SUMMARY_FILES_PER_TOOL = 8;

/** Accumulates one turn's tool calls into the compact Stop-payload summary. */
export interface StopToolSummary {
  /** Records one tool call as it starts: the name plus its raw argument JSON. */
  readonly record: (name: string, argsJson: string) => void;
  readonly snapshot: () => readonly StopToolSummaryEntry[];
}

/** A per-turn collector; publishTurn feeds it every tool_start it publishes. */
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
    const parsed: unknown = JSON.parse(argsJson || "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const path = (parsed as Record<string, unknown>).path;
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
