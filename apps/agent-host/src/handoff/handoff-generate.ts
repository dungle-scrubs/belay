import { cheapestReasoning } from "@host/agent/reasoning-levels";
import { CHARS_PER_TOKEN, estimateTokens } from "@host/metrics/breakdown";
import type { ChatMessage, Provider, ProviderError } from "@host/providers/index";
import { Effect, Stream } from "effect";

/**
 * Generated-handoff prompt generation (02.10, M5/M6): drafting the FIRST prompt a fresh target
 * session should run to continue this session's work. It mirrors compaction's tool-less summarization
 * seam (`agent/compactor.ts`) - a single provider.stream call over a bounded, role-tagged projection of
 * the recent transcript - but produces a runnable continuation prompt instead of a rolling summary.
 *
 * The builder is pure (testable without a provider); the provider call is a thin Effect over
 * `provider.stream`. Provider-specific concerns (which model, reasoning) stay out of the builder - the
 * caller picks the provider (the source's last-turn model, via the compaction controller). The draft
 * is never authoritative: the user approves, edits, or rejects it before any target session launches.
 */

/** Soft cap on the generated prompt length (tokens). The model is asked to stay near this; a hard char
 *  cap backstops a model that ignores it. */
export const HANDOFF_PROMPT_TOKEN_BUDGET = 600;

const HANDOFF_PROMPT_CHAR_CAP = HANDOFF_PROMPT_TOKEN_BUDGET * CHARS_PER_TOKEN;

/** How many of the most recent transcript turns feed the generation prompt (bounded context). */
export const HANDOFF_CONTEXT_TURN_LIMIT = 14;

export interface HandoffGenerationInput {
  /** The source session's projected history (oldest→newest); only the recent tail is used. */
  readonly history: readonly ChatMessage[];
  /** The working directory the target session will run in (same as the source). */
  readonly cwd: string;
  /** The workspace root for the handoff (same as the source). */
  readonly workspace: string;
  /** Optional user emphasis from `/handoff <request>` - what to focus the continuation on. */
  readonly request?: string;
}

/** True when there is at least one user/assistant turn to ground a continuation prompt in. */
export function hasGenerableContext(history: readonly ChatMessage[]): boolean {
  return history.some(
    (m) => (m.role === "user" || m.role === "assistant") && m.content.trim() !== "",
  );
}

/** Renders the recent turns as plain role-tagged text for the model to read. */
function renderTurns(turns: readonly ChatMessage[]): string {
  return turns
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim() !== "")
    .map((m) => `${m.role}: ${m.content.trim()}`)
    .join("\n\n");
}

/**
 * Builds the tool-less generation prompt: one user message instructing the model to write the target
 * session's first prompt from the recent transcript + workspace identity + optional emphasis. The
 * output contract is explicit (a single self-contained continuation prompt, no preamble) so the
 * generated text drops straight into the target as its first `user.message`. Pure - no model call.
 */
export function buildHandoffGenerationPrompt(input: HandoffGenerationInput): ChatMessage[] {
  const recent = input.history.slice(-HANDOFF_CONTEXT_TURN_LIMIT);
  const request = input.request?.trim();
  const sections = [
    "You are writing the FIRST prompt for a FRESH session that will continue the work below. " +
      "Write a single, self-contained continuation prompt addressed to that fresh session: state the " +
      "current goal, what has been done so far, the immediate next step, and any named references " +
      `(files, commands, decisions) it must not lose. Keep it under ~${HANDOFF_PROMPT_TOKEN_BUDGET} ` +
      "tokens. Write ONLY the prompt itself - no preamble, no meta-commentary, no quotes around it.",
    `[Workspace]\ncwd: ${input.cwd}\nworkspace: ${input.workspace}`,
  ];
  if (request) {
    sections.push(`[What to emphasize]\n${request}`);
  }
  sections.push(`[Recent conversation to continue]\n${renderTurns(recent)}`);
  return [{ role: "user", content: sections.join("\n\n") }];
}

/** Caps the generated prompt to the hard char backstop (keeps the head); fires only on overrun. */
function capPrompt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > HANDOFF_PROMPT_CHAR_CAP
    ? trimmed.slice(0, HANDOFF_PROMPT_CHAR_CAP)
    : trimmed;
}

/**
 * Produces the draft target prompt: one tool-less model step over the generation prompt, reasoning
 * forced to the cheapest level (this is a mechanical rewrite, not a thinking task). Accumulates the
 * streamed text and caps it to the budget. `onProgress` is advisory (tokens-so-far / budget) for a
 * live indicator; a no-op when omitted. A provider failure rides the typed ProviderError channel - the
 * caller converts it to a `handoff.failed` event and leaves the source session active.
 */
export function generateHandoffPrompt(
  provider: Provider,
  input: HandoffGenerationInput,
  onProgress?: (tokens: number, budget: number) => void,
): Effect.Effect<string, ProviderError> {
  const draft = provider
    .stream(buildHandoffGenerationPrompt(input), [], cheapestReasoning(provider.reasoningLevels))
    .pipe(
      Stream.mapAccum("", (acc, event) => {
        const next = event.type === "text" ? acc + event.text : acc;
        return [next, next];
      }),
      Stream.tap((acc) =>
        Effect.sync(() => onProgress?.(estimateTokens(acc.length), HANDOFF_PROMPT_TOKEN_BUDGET)),
      ),
      Stream.takeUntil((acc) => estimateTokens(acc.length) >= HANDOFF_PROMPT_TOKEN_BUDGET),
      Stream.runFold("", (_, acc) => acc),
      Effect.map(capPrompt),
    );
  return Effect.sync(() => onProgress?.(0, HANDOFF_PROMPT_TOKEN_BUDGET)).pipe(
    Effect.zipRight(draft),
  );
}
