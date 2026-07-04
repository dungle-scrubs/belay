import { PRODUCER_IDS } from "./identity";
import { events } from "./protocol";
import type { PublishInput } from "./transport";

/**
 * The TANGENT SEED contract (plan 37, M1/M2). A tangent is a side-conversation branched from a SELECTED
 * piece of a parent's transcript. Unlike a fork (`fork.ts`), it does NOT copy the parent's conversation:
 * a fresh tangent session's log is seeded with ONLY the `session.tangentOf` lineage marker, so the
 * tangent's prompt (the host's `buildHistory` over its OWN log) can never contain the parent transcript
 * (D-001). This is the whole isolation guarantee - it is structural, not a runtime filter.
 *
 * This module is the pure core, mirroring `planFork`: given the anchor (parent session id, source message
 * id, selected quote), it returns the ordered {@link PublishInput}s a caller appends to a fresh tangent
 * session through the NORMAL append API - so the store stays a generic append-only substrate with no
 * tangent columns. The selected snapshot is NOT copied as a standalone `user.message` (two consecutive
 * user turns would collapse in the prompt projection, losing it); instead it rides the tangent's FIRST
 * prompt via {@link seedTangentPrompt}, so the model receives the selection inline with the first question.
 */

/** The anchor a tangent is seeded from: where the selection came from and the selected snapshot. */
export interface TangentAnchorSeed {
  readonly parentSessionId: string;
  /** The parent transcript message the selection was scoped to (one `data-message-id`). */
  readonly sourceMessageId: string;
  /** The stable selected-text snapshot (plan 02.5), the tangent's seed context. */
  readonly quote: string;
  /** An optional user-facing tangent title. */
  readonly label?: string;
}

/** The ordered append plan for creating a tangent session (plan 37, M2). */
export interface TangentPlan {
  readonly tangentSessionId: string;
  readonly parentSessionId: string;
  readonly sourceMessageId: string;
  /**
   * Events to append to the fresh tangent session, in order: ONLY the `session.tangentOf` marker. NO
   * parent event is copied - that exclusion is the isolation contract.
   */
  readonly events: readonly PublishInput[];
}

/**
 * Plans a tangent as a list of appends over the NORMAL session API - no store-specific tangent operation,
 * and (unlike {@link planFork}) no parent-prefix copy. The single `session.tangentOf` marker records the
 * anchor and, by its presence, signals a ready tangent (see {@link isTangentReady}). Pure and total.
 */
export function planTangent(args: {
  readonly anchor: TangentAnchorSeed;
  readonly tangentSessionId: string;
}): TangentPlan {
  const marker = events.sessionTangentOf({
    parentSessionId: args.anchor.parentSessionId,
    sourceMessageId: args.anchor.sourceMessageId,
    quote: args.anchor.quote,
    ...(args.anchor.label ? { label: args.anchor.label } : {}),
  });
  return {
    tangentSessionId: args.tangentSessionId,
    parentSessionId: args.anchor.parentSessionId,
    sourceMessageId: args.anchor.sourceMessageId,
    events: [
      {
        type: marker.type,
        producerId: PRODUCER_IDS.web,
        payload: marker.payload,
      },
    ],
  };
}

/**
 * Whether a session's log shows a tangent: the `session.tangentOf` marker is present. Mirrors
 * {@link isForkReady} - the marker doubles as the "this is a tangent" signal.
 */
export function isTangentReady(events: readonly Pick<PublishInput, "type">[]): boolean {
  return events.some((e) => e.type === "session.tangentOf");
}

/**
 * Formats each line of `quote` as a markdown blockquote so the selected snapshot reads as quoted context.
 * Empty lines become a bare `>` so the quote stays one contiguous block (matching the composer's Quote).
 */
function blockquote(quote: string): string {
  return quote
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * Builds the tangent's OPENING prompt: the selected snapshot as quoted context, then the user's first
 * question, as ONE `user.message` text so the model receives the seed inline with the first prompt (a
 * standalone seed message would collapse against the first question in the prompt projection). When the
 * user provides no question, the quote alone stands as the opening context. The single owner of the seed
 * shape, so the web composer and the host/e2e never drift on how a tangent opens. Pure.
 */
export function seedTangentPrompt(quote: string, userText: string): string {
  const trimmedQuote = quote.trim();
  const trimmedText = userText.trim();
  const quoted = trimmedQuote ? blockquote(trimmedQuote) : "";
  if (!quoted) {
    return trimmedText;
  }
  return trimmedText ? `${quoted}\n\n${trimmedText}` : quoted;
}
