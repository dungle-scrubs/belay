/**
 * Responsible for: the tangent PROMPT-ISOLATION diagnostic (plan 37, M2). A tangent turn's prompt must
 * be assembled from the tangent's OWN event log plus the seeded selection only - NEVER the parent's
 * transcript history, tool results, or hidden summaries (D-001). Because {@link buildHistory} is a pure
 * fold over a single session's events, a properly-seeded tangent (its own log, no fork copy) is isolated
 * by construction; this module makes that guarantee OBSERVABLE and testable rather than implicit.
 *
 * Not for: assembling the prompt (history-projection.ts) or deciding when a turn runs (turn-scheduler.ts).
 */
import { hasForkOrigin, type SessionEvent } from "@trevor/session";
import type { ChatMessage } from "../providers";
import { buildHistory } from "./history-projection";

/** A structured report on whether a tangent's prompt excludes the parent transcript (plan 37, M2). */
export interface TangentIsolationReport {
  /** Prompt messages the tangent's own log projects to. */
  readonly tangentPromptMessages: number;
  /** Prompt messages the parent log projects to (the history a fork WOULD have replayed). */
  readonly parentPromptMessages: number;
  /** Parent prompt-message contents found verbatim in the tangent prompt, other than the seeded quote
   *  (each entry is a leak: parent history that reached the tangent's model context). */
  readonly leakedFromParent: readonly string[];
  /** Tangent events tagged with a fork origin - a tangent must have zero (it never copies the parent). */
  readonly forkCopiedEvents: number;
  /** Tangent events that actually belong to the parent session (must be zero - they are separate logs). */
  readonly parentSessionEvents: number;
  /** True when the tangent prompt carries no parent history: no leaks, no fork copies, no parent events. */
  readonly isolated: boolean;
}

const contentsOf = (messages: readonly ChatMessage[]): string[] =>
  messages
    .map((m) => m.content)
    .filter((c): c is string => typeof c === "string" && c.trim() !== "");

/**
 * Builds the isolation report for a tangent's log against its parent's log. Runs the SAME prompt
 * projection the host uses for a real turn ({@link buildHistory}) over each, then checks the tangent's
 * prompt against the parent's: any parent prompt message (a user turn, an assistant reply, a tool result)
 * that also appears in the tangent's prompt is a leak - EXCEPT the seeded selection `quote`, which the
 * tangent legitimately opens with. Also flags any fork-copied or parent-owned event in the tangent log,
 * so a mistakenly fork-style seed is caught even when the copied content happens not to collide.
 */
export function tangentIsolationReport(args: {
  readonly tangentEvents: readonly SessionEvent[];
  readonly parentEvents: readonly SessionEvent[];
  readonly parentSessionId: string;
  /** The seeded selection snapshot the tangent opens with - excluded from the leak check since it is,
   *  by design, present in the tangent prompt. */
  readonly seedQuote?: string;
}): TangentIsolationReport {
  const tangentPrompt = buildHistory(args.tangentEvents);
  const parentPrompt = buildHistory(args.parentEvents);
  const tangentText = contentsOf(tangentPrompt).join("\n");
  const seed = args.seedQuote ?? "";

  const leakedFromParent = contentsOf(parentPrompt).filter(
    (content) => tangentText.includes(content) && !(seed !== "" && seed.includes(content)),
  );
  const forkCopiedEvents = args.tangentEvents.filter(hasForkOrigin).length;
  const parentSessionEvents = args.tangentEvents.filter(
    (event) => event.sessionId === args.parentSessionId,
  ).length;

  return {
    tangentPromptMessages: tangentPrompt.length,
    parentPromptMessages: parentPrompt.length,
    leakedFromParent,
    forkCopiedEvents,
    parentSessionEvents,
    isolated: leakedFromParent.length === 0 && forkCopiedEvents === 0 && parentSessionEvents === 0,
  };
}
