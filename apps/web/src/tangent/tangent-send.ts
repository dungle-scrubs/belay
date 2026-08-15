import { type SessionEvent, seedTangentPrompt } from "@belay/session";
import { toTranscript } from "@/transcript";
import type { TangentTurn } from "./tangent-shell";

/**
 * Strips the folded seed blockquote from the tangent's OPENING user turn for DISPLAY. The first prompt
 * publishes as `seedTangentPrompt(quote, draft)` = the quote as a blockquote + the draft, so the model
 * opens on the selection - but the shell ALSO renders that quote in its own header, so showing it again
 * inside the first user bubble duplicates it (and reads as one blob with the prompt). We remove the exact
 * seeded prefix (`seedTangentPrompt(quote, "")` is that blockquote) so the bubble shows just the user's
 * question; the stored `user.message` text is untouched. A quote-only opening (no draft) keeps the quote.
 */
function stripSeededQuote(text: string, quote: string): string {
  const seed = seedTangentPrompt(quote, "");
  if (!seed || text === seed || !text.startsWith(`${seed}\n`)) {
    return text;
  }
  return text.slice(seed.length).replace(/^\n+/, "");
}

/**
 * Projects a tangent session's OWN events into the shell's minimal user/assistant turn list (plan 37,
 * M6). Only conversational turns render - tool and control rows are omitted, since a tangent is a
 * lightweight side thread. Because this reads the tangent's own log, the tangent transcript can never
 * contain the parent's turns; isolation is structural, not a filter. `seedQuote` (the selection the
 * tangent opened on) lets the FIRST user turn drop its folded copy of that quote from display, since the
 * shell header already shows it (D-plan-37 citation split).
 */
export function tangentTurns(events: readonly SessionEvent[], seedQuote = ""): TangentTurn[] {
  const turns: TangentTurn[] = [];
  let firstUserSeen = false;
  for (const message of toTranscript(events)) {
    if (message.kind === "user") {
      const text =
        !firstUserSeen && seedQuote ? stripSeededQuote(message.text, seedQuote) : message.text;
      firstUserSeen = true;
      turns.push({ id: message.id, role: "user", text });
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
