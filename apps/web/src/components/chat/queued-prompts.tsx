import { ChevronRight } from "lucide-react";
import { ArtifactThumb } from "@/ArtifactThumb";
import { cn } from "@/lib/utils";
import { Markdown } from "@/markdown";
import type { QueuedPrompt } from "@/send-queue";

function Md({ text, muted = false }: { readonly text: string; readonly muted?: boolean }) {
  return (
    <div
      className={cn(
        "smui-md text-[11px] leading-5",
        muted ? "text-muted-foreground" : "text-foreground",
      )}
    >
      <Markdown text={text} muted={muted} />
    </div>
  );
}

export function QueuedPrompts({ queue }: { readonly queue: readonly QueuedPrompt[] }) {
  if (queue.length === 0) {
    return null;
  }

  return (
    <div className="flex max-h-40 flex-col gap-1 overflow-y-auto px-3 pt-1 pb-2 [scrollbar-width:none] opacity-75 [&::-webkit-scrollbar]:hidden">
      {queue.map((q) => (
        <div key={q.id} className="flex items-baseline gap-1.5 text-muted-foreground">
          <ChevronRight aria-hidden className="size-3 shrink-0 translate-y-0.5" />
          <div className="flex min-w-0 flex-col gap-1">
            {q.text ? <Md text={q.text} muted /> : null}
            {q.artifacts?.length ? (
              <div className="flex gap-1.5">
                {q.artifacts.map((ref) => (
                  <ArtifactThumb key={ref.hash} artifact={ref} size={32} square />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
