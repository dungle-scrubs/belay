import { type SessionEvent, seedTangentPrompt } from "@trevor/session";
import { toTranscript } from "@/transcript";
import type { TangentTurn } from "./tangent-shell";

/**
 * Projects a tangent session's OWN events into the shell's minimal user/assistant turn list (plan 37,
 * M6). Only conversational turns render - tool and control rows are omitted, since a tangent is a
 * lightweight side thread. Because this reads the tangent's own log, the tangent transcript can never
 * contain the parent's turns; isolation is structural, not a filter.
 */
export function tangentTurns(events: readonly SessionEvent[]): TangentTurn[] {
  const turns: TangentTurn[] = [];
  for (const message of toTranscript(events)) {
    if (message.kind === "user") {
      turns.push({ id: message.id, role: "user", text: message.text });
    } else if (message.kind === "assistant" && (message.text.trim() !== "" || !message.done)) {
      // Render text/streaming segments; skip a not-yet-started empty assistant shell.
      turns.push({
        id: message.id,
        role: "assistant",
        text: message.text,
        streaming: !message.done,
      });
    }
  }
  return turns;
}

/** Whether the tangent has any user prompt yet - its first send folds the seed, later sends are plain. */
export function tangentHasUserTurn(turns: readonly TangentTurn[]): boolean {
  return turns.some((turn) => turn.role === "user");
}

/**
 * The text to publish for the tangent's NEXT prompt. The FIRST prompt folds the seed snapshot in (via
 * {@link seedTangentPrompt}) so the model opens on the selected context; every later prompt is the plain
 * draft. Pure - the single owner of the seed-on-first-prompt rule.
 */
export function nextTangentPrompt(
  turns: readonly TangentTurn[],
  quote: string,
  draft: string,
): string {
  return tangentHasUserTurn(turns) ? draft.trim() : seedTangentPrompt(quote, draft);
}
