import { MessageCircleQuestion } from "lucide-react";
import { truncate } from "@/derive";
import { cn } from "@/lib/utils";
import type { QuestionMessage } from "@/transcript";

/**
 * The slim transcript record of a resolved `ask_user` interaction (D-001/D-002): what Trevor asked and
 * how the user answered, rendered compactly - a question-mark icon, an "asked" label, an outcome tag,
 * and one `question -> answer` row per asked question. It is intentionally restrained (no nested cards,
 * no interactive controls); the live pending question stays owned by `QuestionSurface`.
 *
 * `oneLine` collapses the whole interaction to a single truncated row (D-003) for compact transcript
 * settings, with the full text exposed through the row's `title`.
 */
export function QuestionTranscriptItem({
  message,
  oneLine = false,
}: {
  message: QuestionMessage;
  oneLine?: boolean;
}) {
  const { outcome, items, summary } = message;

  const fullText =
    items.length > 0
      ? items.map((it) => (it.answer ? `${it.question} → ${it.answer}` : it.question)).join(" · ")
      : summary;

  if (oneLine) {
    const first = items[0];
    const head = first ? `${first.question}${first.answer ? ` → ${first.answer}` : ""}` : summary;
    const more = items.length > 1 ? ` +${items.length - 1} more` : "";
    return (
      <div
        className="aui-question-item flex items-center gap-1.5 text-xs text-muted-foreground"
        title={`asked (${outcome}): ${fullText}`}
      >
        <MessageCircleQuestion className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">
          {truncate(head, 90)}
          {more}
        </span>
        <span className={cn("shrink-0", OUTCOME_TONE[outcome])}>{outcome}</span>
      </div>
    );
  }

  return (
    <div className="aui-question-item flex flex-col gap-1 text-sm">
      <div className="flex items-center gap-1.5 text-label tracking-wider text-muted-foreground/80">
        <MessageCircleQuestion className="size-3.5" aria-hidden="true" />
        <span>asked</span>
        <span aria-hidden="true">·</span>
        <span className={OUTCOME_TONE[outcome]}>{outcome}</span>
      </div>
      {items.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {items.map((it) => (
            <li key={`${message.questionId}:${it.id}`} className="flex flex-wrap gap-x-1.5">
              <span className="text-muted-foreground">{it.question}</span>
              {it.answer ? (
                <span className="text-foreground">→ {it.answer}</span>
              ) : (
                <span className="text-muted-foreground/60">→ {outcome}</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-muted-foreground">{summary}</div>
      )}
    </div>
  );
}

/** Outcome tag color: answered is positive, decline/cancel are negative, expired is muted. */
const OUTCOME_TONE: Record<QuestionMessage["outcome"], string> = {
  answered: "text-smui-green",
  declined: "text-smui-red",
  cancelled: "text-smui-red",
  expired: "text-muted-foreground",
};
