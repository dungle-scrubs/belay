import { ChevronRight, X } from "lucide-react";
import { ArtifactThumb } from "@/artifact-thumb";
import type { QueuedPrompt } from "@/send-queue";

/**
 * The durable follow-up queue panel (plan 47): the prompts published behind the active turn, waiting
 * their turn on the host. Each is durable (it survives a reload / host restart), so the row exposes an
 * unqueue control that supersedes it on the log. First Escape folds the whole queue into one steering
 * prompt; Up at an empty composer pulls the newest back to edit - both drive the same durable log.
 */
export function QueuedPrompts({
  queue,
  onUnqueue,
}: {
  readonly queue: readonly QueuedPrompt[];
  readonly onUnqueue: (id: string) => void;
}) {
  if (queue.length === 0) {
    return null;
  }

  return (
    <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto pt-1 pr-3 pb-0 pl-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {queue.map((q) => (
        <div
          key={q.id}
          className="group flex items-start gap-1.5 rounded-sm pr-1 pl-0 text-muted-foreground transition-colors hover:bg-muted/25"
        >
          <ChevronRight aria-hidden className="mt-px size-3 shrink-0 text-muted-foreground/70" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {q.text ? (
              <div className="whitespace-pre-wrap text-[12px] leading-[14px] text-muted-foreground/80">
                {q.text}
              </div>
            ) : null}
            {q.artifacts?.length ? (
              <div className="flex gap-1.5">
                {q.artifacts.map((ref) => (
                  <ArtifactThumb key={ref.hash} artifact={ref} size={32} square />
                ))}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Unqueue prompt"
            title="Unqueue"
            onClick={() => onUnqueue(q.id)}
            className="shrink-0 self-start rounded p-0.5 text-muted-foreground/70 opacity-0 transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-hover:text-muted-foreground"
          >
            <X aria-hidden className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
