import type { ArtifactRef } from "@trevor/session";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { artifactSrc } from "@/blob";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * The same-message image carousel (D-092 M5): clicking any image in a user message opens this
 * centered dialog over ONLY that message's images. It is large enough to inspect but not full
 * screen; the image is responsive and aspect-preserving; previous/next cycle through the images in
 * submitted order; ArrowLeft/ArrowRight navigate and Escape closes (Escape + focus trap come from
 * the underlying radix Dialog). The index/count is shown and each image carries an accessible label.
 */

export interface ImageCarouselProps {
  /** The same-message image set, in submitted order. */
  readonly images: readonly ArtifactRef[];
  readonly open: boolean;
  /** The image to show first when opening. */
  readonly initialIndex: number;
  readonly onOpenChange: (open: boolean) => void;
  readonly srcOf?: (hash: string) => string;
}

export function ImageCarousel({
  images,
  open,
  initialIndex,
  onOpenChange,
  srcOf = artifactSrc,
}: ImageCarouselProps) {
  const count = images.length;
  const [index, setIndex] = useState(initialIndex);
  const [broken, setBroken] = useState(false);

  // Seed the index from the clicked image each time the carousel opens (or the target changes).
  useEffect(() => {
    if (open) {
      setIndex(Math.min(Math.max(initialIndex, 0), Math.max(count - 1, 0)));
    }
  }, [open, initialIndex, count]);

  // Reset the broken-image fallback when the visible image changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: index drives the reset.
  useEffect(() => setBroken(false), [index]);

  if (count === 0) {
    return null;
  }

  const safeIndex = Math.min(index, count - 1);
  const current = images[safeIndex];
  const prev = () => setIndex((i) => (i - 1 + count) % count);
  const next = () => setIndex((i) => (i + 1) % count);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      prev();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      next();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl gap-3" onKeyDown={onKeyDown}>
        <DialogTitle className="text-sm font-normal text-muted-foreground">
          Image {safeIndex + 1} of {count}
          {current?.name ? ` · ${current.name}` : ""}
        </DialogTitle>

        <div className="flex items-center justify-center gap-2">
          {count > 1 ? (
            <button
              type="button"
              onClick={prev}
              aria-label="previous image"
              className="shrink-0 rounded-full border border-border bg-card p-1.5 text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="size-5" />
            </button>
          ) : null}

          <div className="flex min-h-[40vh] min-w-0 flex-1 items-center justify-center">
            {current && !broken ? (
              <img
                src={srcOf(current.hash)}
                alt={current.name ?? `image ${safeIndex + 1}`}
                onError={() => setBroken(true)}
                className="max-h-[78vh] max-w-full object-contain"
              />
            ) : current ? (
              <a
                href={srcOf(current.hash)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
              >
                <FileText className="size-4" />
                {current.name ?? current.kind}
              </a>
            ) : null}
          </div>

          {count > 1 ? (
            <button
              type="button"
              onClick={next}
              aria-label="next image"
              className="shrink-0 rounded-full border border-border bg-card p-1.5 text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className="size-5" />
            </button>
          ) : null}
        </div>

        {count > 1 ? (
          <div className="flex justify-center gap-1.5" aria-hidden>
            {images.map((image, i) => (
              <span
                key={image.hash}
                className={cn(
                  "size-1.5 rounded-full",
                  i === safeIndex ? "bg-foreground" : "bg-muted-foreground/40",
                )}
              />
            ))}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
