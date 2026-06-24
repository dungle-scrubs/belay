import { decodeTrevorEvent, type SessionEvent } from "@trevor/session";
import type { ChatMessage } from "../providers";

/**
 * Projects the durable session event log into the host's prompt view: the
 * `ChatMessage[]` the model is handed for a turn. This is the host-side mirror of
 * the web's `toTranscript` (transcript.ts) - one pure fold over `SessionEvent[]`,
 * read through `decodeTrevorEvent` so it never hand-guards raw payload fields.
 *
 * It OWNS every conversation-shaping invariant that keeps the prompt model-safe -
 * the rules once scattered as imperative mutation across main.ts plus the turn-time
 * `sanitizeHistory` defense (now folded in), so the projection emits an
 * already-model-safe view and no second pass is needed:
 *   - user.message  -> a `{role:"user"}` turn (with artifacts when present),
 *     collapsing onto a preceding user turn so the prompt alternates user/assistant
 *   - assistant.completed -> a `{role:"assistant"}` turn, but a blank/whitespace-only
 *     completion is dropped (saving it teaches the model empty replies are normal -
 *     the cascade behind silent dead-ends), and a reply with no preceding user turn
 *     is dropped so the prompt always opens on a user message
 *   - user.command "/clear" -> resets the projection to empty from that point
 *   - every other event (assistant.started/delta/thinking, tool.*, host.*) -> ignored
 *
 * `selfProducerId` excludes the host's own user.message / user.command echoes
 * (main.ts gates both on `producerId !== PRODUCER_ID`); assistant.completed is
 * folded regardless of producer, since the host authors it.
 *
 * It is NOT responsible for scheduling - when a turn runs, deferring a mid-turn
 * prompt, or the one-turn-at-a-time gate all live with the turn machine, not here.
 *
 * Pure and total: the same event log always yields the same messages, which is what
 * makes it the natural home for compaction's prompt-builder (trevor-v2 D-040) - pins
 * + summary substitution + recent-verbatim become one more case in this fold.
 */
export function buildHistory(
  events: readonly SessionEvent[],
  options: { readonly selfProducerId?: string } = {},
): ChatMessage[] {
  const { selfProducerId } = options;
  const out: ChatMessage[] = [];
  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    if (!decoded) {
      continue;
    }
    const fromSelf = selfProducerId !== undefined && event.producerId === selfProducerId;
    if (decoded.type === "user.message") {
      if (fromSelf) {
        continue;
      }
      const turn: ChatMessage = decoded.artifacts.length
        ? { role: "user", content: decoded.text, artifacts: decoded.artifacts }
        : { role: "user", content: decoded.text };
      // Collapse consecutive user turns to the latest: with one-turn-at-a-time
      // dispatch this only fires for a genuinely abandoned turn (e.g. the host
      // crashed mid-answer) - feed the model the latest prompt, not two unanswered.
      if (out[out.length - 1]?.role === "user") {
        out[out.length - 1] = turn;
      } else {
        out.push(turn);
      }
    } else if (decoded.type === "assistant.completed") {
      // Only a real reply joins the prompt. `.trim()` catches the whitespace-only
      // case a bare truthiness check would miss. A reply with no preceding user turn
      // is dropped too: the prompt must open on a user message, so a stray leading
      // assistant turn (e.g. a clear that landed mid-answer) never reaches the model.
      if (decoded.text.trim() && out.length > 0) {
        out.push({ role: "assistant", content: decoded.text });
      }
    } else if (decoded.type === "user.command" && !fromSelf && decoded.command === "/clear") {
      // Reset the baseline so the prompt starts empty after a clear - applied on
      // replay too, so a reload stays clean. The old events stay in the durable log
      // but never reach the prompt again.
      out.length = 0;
    }
  }
  return out;
}
