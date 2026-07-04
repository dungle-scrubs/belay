import { ChevronRight, X } from "lucide-react";
import { ArtifactThumb } from "@/artifact-thumb";
import { MarkdownBody } from "@/components/chat/markdown-body";
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
    <div className="flex max-h-40 flex-col gap-1 overflow-y-auto px-3 pt-1 pb-2 [scrollbar-width:none] opacity-75 [&::-webkit-scrollbar]:hidden">
      {queue.map((q) => (
        <div key={q.id} className="group flex items-baseline gap-1.5 text-muted-foreground">
          <ChevronRight aria-hidden className="size-3 shrink-0 translate-y-0.5" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {q.text ? <MarkdownBody text={q.text} muted className="text-[11px] leading-5" /> : null}
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
            className="shrink-0 self-start rounded p-0.5 text-muted-foreground/60 opacity-0 transition hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          >
            <X aria-hidden className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
