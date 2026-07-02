import { randomUUID } from "node:crypto";
import {
  events,
  type ProviderQuestionAnswer,
  type ProviderQuestionContract,
  type TrevorEventInput,
  validateAnswer,
  validateContract,
} from "@trevor/session";
import { Effect } from "effect";
import { ToolInputError } from "../tools/errors";

/**
 * The generic pending-question runtime behind the `ask_user` tool. It is deliberately provider- and
 * tool-agnostic (M4 boundary): it owns blocking a tool call on a user answer and nothing about how the
 * question was authored. The `ask_user` tool calls `ask`; the host's inbound event lane calls
 * `submitAnswer` when the browser publishes a `provider.question.answer`.
 *
 * Lifecycle:
 *   - `ask` validates the contract, emits `provider.question.requested`, registers a pending waiter, and
 *     returns an Effect that suspends until the waiter resolves. Interrupting that Effect (the turn was
 *     cancelled / the run ended before an answer) removes the waiter and emits a `cancelled` resolution -
 *     this is the run-ended-before-answer path (AQ003), handled by fiber interruption rather than a timer.
 *   - `submitAnswer` matches by `questionId`, validates the answer against the stored contract, resolves
 *     the waiter with the tool-result string, and emits `provider.question.resolved`. An unknown id
 *     (AQ001) or an answer that fails validation (AQ002) leaves every active run untouched.
 *
 * The emitter is injected once at host startup so this module stays free of transport details; tests
 * inject a collecting emitter. Raw answer bodies never enter the resolved `summary` (security): only a
 * sanitized outcome + question count.
 *
 * Responsible for: the pending-question runtime behind ask_user - blocking a tool call until the
 * user's answer resolves it, emitting the question lifecycle events.
 * Not for: the ask_user tool definition itself - that surface is src/tools/ask-user.ts.
 */

/** Where a `submitAnswer` landed, so the inbound lane can log AQ001/AQ002 without touching runs. */
export type SubmitResult =
  | { readonly status: "resolved"; readonly outcome: ResolvedOutcome }
  | { readonly status: "unknown" }
  | { readonly status: "invalid"; readonly issues: readonly string[] };

type ResolvedOutcome = "answered" | "declined" | "cancelled";

/** Publishes a session event; injected so this module never imports the transport. */
export type QuestionEmitter = (event: TrevorEventInput) => void;

interface Pending {
  readonly questionId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly contract: ProviderQuestionContract;
  readonly resolve: (result: string) => void;
}

export class ProviderQuestionRuntime {
  private emitter: QuestionEmitter | null = null;
  private readonly pending = new Map<string, Pending>();

  /** Wire the transport publish (once, at host startup). */
  configure(emitter: QuestionEmitter): void {
    this.emitter = emitter;
  }

  /** Drop all state (tests + host teardown); does not emit. */
  reset(): void {
    this.emitter = null;
    this.pending.clear();
  }

  /** Number of questions currently awaiting an answer (inspectable state for diagnostics/tests). */
  get pendingCount(): number {
    return this.pending.size;
  }

  private emit(event: TrevorEventInput): void {
    this.emitter?.(event);
  }

  /**
   * The `ask_user` tool's blocking entry: emit the request, then suspend until an answer arrives. A
   * malformed contract fails fast as a ToolInputError (the model sees the reason). `runId`/`toolCallId`
   * correlate the request to the active turn + tool call for the UI; `questionId` is the lifecycle key.
   */
  ask(
    contract: ProviderQuestionContract,
    runId: string,
    toolCallId: string,
  ): Effect.Effect<string, ToolInputError> {
    const issues = validateContract(contract);
    if (issues.length > 0) {
      return Effect.fail(
        new ToolInputError({ tool: "ask_user", detail: issues.map((i) => i.message).join("; ") }),
      );
    }
    return Effect.async<string, ToolInputError>((resume) => {
      const questionId = randomUUID();
      this.pending.set(questionId, {
        questionId,
        runId,
        toolCallId,
        contract,
        resolve: (result) => {
          this.pending.delete(questionId);
          resume(Effect.succeed(result));
        },
      });
      this.emit(
        events.providerQuestionRequested({
          questionId,
          runId,
          toolCallId,
          toolName: "ask_user",
          adapter: "ask_user",
          contract,
        }),
      );
      // Interrupt cleanup: the turn was cancelled / the run ended before an answer (AQ003). Drop the
      // waiter and close the pending question so the UI stops showing it.
      return Effect.sync(() => {
        const stillPending = this.pending.delete(questionId);
        if (stillPending) {
          this.emit(
            events.providerQuestionResolved({
              questionId,
              runId,
              toolCallId,
              outcome: "cancelled",
              summary: "Cancelled - the run ended before it was answered.",
            }),
          );
        }
      });
    });
  }

  /**
   * Apply an inbound answer. Resolves the matching tool call and closes the question; rejects an unknown
   * id (AQ001) and an answer that fails contract validation (AQ002) without disturbing any run.
   */
  submitAnswer(questionId: string, answer: ProviderQuestionAnswer): SubmitResult {
    const entry = this.pending.get(questionId);
    if (!entry) {
      return { status: "unknown" };
    }
    if (answer.action === "accept") {
      const issues = validateAnswer(entry.contract, answer);
      if (issues.length > 0) {
        return { status: "invalid", issues: issues.map((i) => i.message) };
      }
    }
    entry.resolve(formatToolResult(answer));
    const outcome: ResolvedOutcome =
      answer.action === "accept"
        ? "answered"
        : answer.action === "decline"
          ? "declined"
          : "cancelled";
    this.emit(
      events.providerQuestionResolved({
        questionId,
        runId: entry.runId,
        toolCallId: entry.toolCallId,
        outcome,
        summary: resolvedSummary(answer),
      }),
    );
    return { status: "resolved", outcome };
  }
}

/** The host-wide singleton, configured in main.ts and called from the tool + inbound lane. */
export const providerQuestionRuntime = new ProviderQuestionRuntime();

/** The model-facing tool result: a readable per-question recap of what the user chose. */
export function formatToolResult(answer: ProviderQuestionAnswer): string {
  if (answer.action !== "accept") {
    return answer.action === "decline"
      ? "The user declined to answer. Continue without this decision or ask differently."
      : "The user cancelled the question.";
  }
  if (answer.questions.length === 0) {
    return "The user submitted an empty answer.";
  }
  return answer.questions
    .map((a) => {
      if (a.defer) {
        return `- ${a.id}: (deferred - the user skipped this)`;
      }
      const extra = [
        a.notes ? `note: ${a.notes}` : null,
        a.reason ? `reason: ${a.reason}` : null,
      ].filter((s): s is string => s != null);
      const body = a.answer.length > 0 ? a.answer : "(no answer)";
      return `- ${a.id}: ${body}${extra.length > 0 ? ` (${extra.join("; ")})` : ""}`;
    })
    .join("\n");
}

/** A sanitized one-liner for the resolved event - never the raw answer body (security). */
function resolvedSummary(answer: ProviderQuestionAnswer): string {
  if (answer.action !== "accept") {
    return answer.action === "decline" ? "Declined" : "Cancelled";
  }
  const n = answer.questions.length;
  return `Answered ${n} ${n === 1 ? "question" : "questions"}`;
}
