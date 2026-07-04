/**
 * Responsible for: projecting the durable session event log into the model-safe ChatMessage[]
 * prompt view for a turn (buildHistory - folds, pins, tool reconstruction, /clear).
 * Not for: when turns run or the one-turn-at-a-time gate - turn-scheduler.ts.
 */
import {
  type ArtifactRef,
  formatLucidFeedbackForPrompt,
  isSelfProducer,
  type PastePayload,
  type SessionEvent,
  type TaskSnapshot,
} from "@trevor/session";
import type { ChatMessage } from "../providers";
import { analyzeCompactionLog } from "./compaction-planner";
import { toolCallGrouper } from "./tool-messages";

/**
 * Renders a compaction fold into one synthetic assistant message: the rolling summary plus
 * the live task list, clearly labelled so the model reads it as its own distilled progress.
 * The original goal is pinned as a separate (user) message ahead of this one (see buildHistory).
 */
function renderFold(summary: string, tasks: readonly TaskSnapshot[]): string {
  const parts = [`[Summary of earlier conversation]\n${summary}`];
  if (tasks.length > 0) {
    const lines = tasks.map((t) => `- [${t.status}] ${t.subject}`).join("\n");
    parts.push(`[Current tasks]\n${lines}`);
  }
  return parts.join("\n\n");
}

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
 *   - tool.started / tool.completed -> RECONSTRUCTED into the conversation: a contiguous run of
 *     tool.started becomes one `{role:"assistant", toolCalls}` message and the following
 *     tool.completed become its `{role:"tool"}` results. Tool activity is carried ACROSS turns
 *     (the mainstream-harness behaviour) - the model keeps what it read until compaction folds it -
 *     not discarded the moment a turn ends. This is what makes the prompt grow, and therefore what
 *     compaction (D-040) actually folds.
 *   - tasks.current -> tracked as the live task-list pin (not a turn of its own)
 *   - context.compacted -> the cross-turn fold (D-040): replaces the folded prefix with
 *     the pins (original goal + task list) and the rolling summary, keeping the recent
 *     post-throughSeq turns verbatim (with their tool results). The latest fold in the chain wins.
 *   - user.command "/clear" -> resets the projection (and any fold + pins) to empty
 *   - every other event (assistant.started/delta/thinking, host.*) -> ignored
 *
 * Compaction shapes ONLY this prompt projection. The durable log is never mutated and the
 * UI transcript (transcript.ts) still renders the full history (D-042) - the fold is a
 * prompt-budget device, not a history rewrite.
 *
 * `selfProducerId` excludes the host's own user.message / user.command echoes
 * (main.ts gates both on `producerId !== PRODUCER_ID`); assistant.completed is
 * folded regardless of producer, since the host authors it.
 *
 * It is NOT responsible for scheduling - when a turn runs, deferring a mid-turn
 * prompt, or the one-turn-at-a-time gate all live with the turn machine, not here.
 *
 * Pure and total: the same event log always yields the same messages.
 */
export function buildHistory(
  events: readonly SessionEvent[],
  options: { readonly selfProducerId?: string } = {},
): ChatMessage[] {
  const { selfProducerId } = options;
  const toUserTurn = (decoded: {
    text: string;
    artifacts: readonly ArtifactRef[];
    pastes: readonly PastePayload[];
  }): ChatMessage => ({
    role: "user",
    content: decoded.text,
    ...(decoded.artifacts.length ? { artifacts: decoded.artifacts } : {}),
    ...(decoded.pastes.length ? { pastes: decoded.pastes } : {}),
  });

  // The baseline (everything after the last /clear) and, within it, the latest fold plus the pins.
  // Shared with the compaction planner so the fold and goal can't drift. The pins
  // (D-040) re-enter the prompt OUTSIDE the fold: the original goal keeps the model anchored on the
  // objective after older turns collapse to a summary, and the live task list rides in the fold.
  const analysis = analyzeCompactionLog(events, selfProducerId);
  const goal = analysis.goal ? toUserTurn(analysis.goal) : null;

  // Pass 2 - project the baseline. When folded, the pins + rolling summary lead, then only the
  // RECENT turns (seq > throughSeq) are projected verbatim; the summary already represents the
  // rest. Skipping by seq (not by log position) keeps a turn that arrived AFTER throughSeq but
  // BEFORE the fold event was written - the blocking-before case - in the recent run. With no
  // fold, this is the plain projection, byte-for-byte the pre-compaction behaviour.
  const out: ChatMessage[] = [];
  if (analysis.fold) {
    if (goal) {
      out.push(goal);
    }
    out.push({ role: "assistant", content: renderFold(analysis.fold.summary, analysis.tasks) });
  }
  // True when the trailing user turn is (or ends with) located Lucid feedback (M5): a following prompt
  // then CONCATENATES rather than replacing, so real located feedback is never treated as an abandoned
  // turn and dropped. Set by the lucid.feedback arm, cleared whenever a plain user turn is pushed.
  let feedbackTail = false;
  const pushUser = (turn: ChatMessage): void => {
    // Collapse consecutive user turns to the latest: with one-turn-at-a-time dispatch this only
    // fires for a genuinely abandoned turn (e.g. the host crashed mid-answer) - feed the model
    // the latest prompt, not two unanswered. But a Lucid-feedback tail is real content, so a prompt
    // arriving after it merges instead of clobbering it.
    const last = out[out.length - 1];
    if (last?.role === "user") {
      out[out.length - 1] = feedbackTail
        ? { ...last, content: `${last.content}\n\n${turn.content}` }
        : turn;
    } else {
      out.push(turn);
    }
    feedbackTail = false;
  };
  // Tool-call reconstruction (the shared rule - see toolCallGrouper). out.length > 0 gates a leading
  // tool-call message so the prompt always opens on a user turn.
  const tools = toolCallGrouper((message) => out.push(message));
  for (let index = analysis.baselineStart; index < events.length; index += 1) {
    const event = events[index];
    const decoded = analysis.decoded[index];
    if (!event || !decoded) {
      continue;
    }
    if (analysis.fold && event.seq <= analysis.fold.throughSeq) {
      continue; // folded away - the summary stands in for it
    }
    if (decoded.type === "user.message") {
      if (isSelfProducer(event.producerId, selfProducerId)) {
        continue;
      }
      tools.reset();
      pushUser(toUserTurn(decoded));
    } else if (decoded.type === "lucid.feedback") {
      // Located Lucid review feedback (plan 27, M5) enters the prompt as STRUCTURED DATA, never as a
      // blindly-injected instruction: the shared framer fences every human note so it reads as a
      // located comment, not a command. It rides as a user turn (the human addressed the agent). To
      // preserve strict user/assistant alternation without EVER discarding feedback, a run adjacent to
      // another user turn is CONCATENATED (not replaced, as pushUser does for abandoned prompts).
      tools.reset();
      const framed = formatLucidFeedbackForPrompt({
        lucidId: decoded.lucidId,
        version: decoded.version,
        cursor: decoded.cursor,
        annotations: decoded.annotations,
        ...(decoded.message ? { message: decoded.message } : {}),
      });
      const last = out[out.length - 1];
      if (last?.role === "user") {
        out[out.length - 1] = { ...last, content: `${last.content}\n\n${framed}` };
      } else {
        out.push({ role: "user", content: framed });
      }
      feedbackTail = true;
    } else if (decoded.type === "tool.started") {
      tools.started(decoded.callId, decoded.name, decoded.arguments);
    } else if (decoded.type === "tool.completed") {
      tools.completed(decoded.callId, decoded.name, decoded.result, out.length > 0);
    } else if (decoded.type === "assistant.completed") {
      tools.reset();
      // Only a real reply joins the prompt. `.trim()` catches the whitespace-only case a bare
      // truthiness check would miss. A reply with no preceding user turn is dropped too: the
      // prompt must open on a user message, so a stray leading assistant turn (e.g. a clear that
      // landed mid-answer) never reaches the model.
      if (decoded.text.trim() && out.length > 0) {
        out.push({ role: "assistant", content: decoded.text });
      }
    }
  }
  return out;
}
