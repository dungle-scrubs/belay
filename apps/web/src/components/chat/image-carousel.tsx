import type { ArtifactRef } from "@belay/session";
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
  const [loaded, setLoaded] = useState(false);

  // Seed the index from the clicked image each time the carousel opens (or the target changes).
  useEffect(() => {
    if (open) {
      setIndex(Math.min(Math.max(initialIndex, 0), Math.max(count - 1, 0)));
    }
  }, [open, initialIndex, count]);

  // Reset the broken + loading state when the visible image changes, so the next image shows its own
  // shimmer while it decodes and re-evaluates its own availability.
  // biome-ignore lint/correctness/useExhaustiveDependencies: index drives the reset.
  useEffect(() => {
    setBroken(false);
    setLoaded(false);
  }, [index]);

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
      {/* The popup sizes to the image's natural dimensions, capped at ~85% of the viewport (the image
          itself is capped just under that to leave room for the title/dots, so the whole modal lands
          near 85%). `w-fit` overrides the dialog's default full width so a small image gets a small
          popup; `max-w-[85vw]` (incl. the sm: override) caps a large one. */}
      <DialogContent className="w-fit max-w-[85vw] gap-3 sm:max-w-[85vw]" onKeyDown={onKeyDown}>
        {/* The counter never truncates; a long filename does (with the full name in its tooltip) so
            the title stays on one line and the modal doesn't blow past its width cap. */}
        <DialogTitle className="flex min-w-0 items-center gap-2 text-sm font-normal text-muted-foreground">
          <span className="shrink-0">
            Image {safeIndex + 1} of {count}
          </span>
          {current?.name ? (
            <>
              <span aria-hidden className="shrink-0">
                ·
              </span>
              <span className="min-w-0 truncate" title={current.name}>
                {current.name}
              </span>
            </>
          ) : null}
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

          <div className="relative flex min-h-[240px] min-w-[240px] items-center justify-center">
            {current && !broken ? (
              <>
                {/* A shimmer reserves the inspection area while the full image decodes, so opening the
                    carousel doesn't flash an empty modal that then resizes (plan 34). */}
                {loaded ? null : <span aria-hidden className="skeleton absolute inset-0" />}
                <img
                  src={srcOf(current.hash)}
                  alt={current.name ?? `image ${safeIndex + 1}`}
                  onLoad={() => setLoaded(true)}
                  onError={() => setBroken(true)}
                  // Natural size, capped so the whole modal stays near 85% of the viewport - the height
                  // cap sits under 85vh to leave room for the title/dots + padding, the width under 85vw
                  // to leave room for the nav buttons. Contained, so aspect ratio is kept.
                  className={cn(
                    "max-h-[75vh] max-w-[80vw] object-contain transition-opacity duration-200",
                    loaded ? "opacity-100" : "opacity-0",
                  )}
                />
              </>
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
