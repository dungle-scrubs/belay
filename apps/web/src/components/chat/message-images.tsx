import type { ArtifactRef } from "@trevor/session";
import { FileText } from "lucide-react";
import { useState } from "react";
import { artifactSrc } from "@/blob";
import { cn } from "@/lib/utils";

/**
 * The user-message image set (D-092 M4, refined plan 34): renders the images attached to a submitted
 * prompt in the SAME transcript item as the text, contained (never cropped) so aspect ratio is kept.
 * A single image gets a taller cap and a subtle filename caption; a set of images gets a shorter cap
 * and lays out as a scannable grid/row (names stay in the tooltip + aria-label so the grid isn't
 * noisy). Each tile reserves a minimum footprint and shows a shimmer while the image decodes, so a
 * slow or unavailable image never collapses the row and then jumps it (the 12.2 scroll contract,
 * plan 34 D-003). A broken / missing / non-image artifact degrades to a quiet file/link row - never
 * a broken-image icon. Clicking any image calls `onOpen` with its set index (the same-message
 * carousel); the tile itself never owns carousel state.
 *
 * Compact-mode note (plan 34, not implemented here): a future compact transcript layout should
 * summarize an image set as a single count chip (e.g. "3 images") that expands to this surface on
 * demand, rather than rendering every tile inline. The submitted `ArtifactRef` list stays the source
 * of truth, so compact mode is a presentation choice over the same data.
 */

export interface MessageImagesProps {
  /** The message's image artifacts, rendered inline as a set (already partitioned by the caller). */
  readonly images: readonly ArtifactRef[];
  /** The message's non-image artifacts, rendered as quiet file/link rows (already partitioned). */
  readonly others: readonly ArtifactRef[];
  /** Opens an artifact in the shared artifact workspace instead of the local carousel/link. */
  readonly onOpenArtifact?: (artifact: ArtifactRef) => void;
  /** Opens the same-message carousel at the given image-set index (M5). */
  readonly onOpen?: (index: number) => void;
  /** Resolves a hash to an image URL; defaults to the blob-store `artifactSrc`. */
  readonly srcOf?: (hash: string) => string;
  readonly className?: string;
}

/** A quiet file/link row for a document, non-image, or image that failed to load (no broken icon). */
function FileRowContent({ artifact }: { readonly artifact: ArtifactRef }) {
  return (
    <>
      <FileText className="size-3.5 shrink-0" />
      <span className="max-w-[16rem] truncate">{artifact.name ?? artifact.kind}</span>
    </>
  );
}

const fileRowClassName =
  "inline-flex items-center gap-1.5 border border-border bg-card px-2 py-1 text-xs text-muted-foreground hover:text-foreground";

function FileRow({
  artifact,
  onOpenArtifact,
  srcOf,
}: {
  artifact: ArtifactRef;
  onOpenArtifact?: (artifact: ArtifactRef) => void;
  srcOf: (hash: string) => string;
}) {
  if (onOpenArtifact) {
    return (
      <button type="button" onClick={() => onOpenArtifact(artifact)} className={fileRowClassName}>
        <FileRowContent artifact={artifact} />
      </button>
    );
  }

  return (
    <a href={srcOf(artifact.hash)} target="_blank" rel="noreferrer" className={fileRowClassName}>
      <FileRowContent artifact={artifact} />
    </a>
  );
}

/**
 * The tile's bordered frame. Reserves a minimum footprint (so a loading/unavailable image never
 * collapses then jumps the row - plan 34 D-003) and carries the hover/focus affordances. A single
 * image gets a taller cap so a screenshot stays legible; a set gets a shorter cap so the grid stays
 * scannable. Focus + hover match the button primitive's tokens.
 */
const tileFrameClass = (single: boolean) =>
  cn(
    "group relative flex items-center justify-center overflow-hidden border border-border bg-card leading-none outline-none transition-colors hover:border-muted-foreground/40 focus-visible:ring-[3px] focus-visible:ring-ring/50",
    single
      ? "min-h-[200px] min-w-[200px] max-w-full"
      : "min-h-[120px] min-w-[120px] w-full @md:w-auto",
  );

/** The contained image inside a tile: at most the tile cap on either side, aspect preserved. */
const tileImageClass = (single: boolean) =>
  cn(
    "block object-contain transition-opacity duration-200",
    single ? "max-h-[360px] w-auto max-w-full" : "max-h-[200px] w-full max-w-[200px] @md:w-auto",
  );

/**
 * The reserved-footprint shimmer an inline tile shows while its image decodes. Exported so the
 * loading state is reviewable in Storybook (and reusable by a future image surface) without racing a
 * real network load.
 */
export function InlineImageLoading({ single = false }: { single?: boolean }) {
  return (
    <div className={tileFrameClass(single)} role="status" aria-label="loading image">
      <span aria-hidden className="skeleton absolute inset-0" />
    </div>
  );
}

/**
 * One image tile: a contained, click-to-open thumbnail that shows a shimmer while it decodes and
 * degrades to a quiet file row on error. `single` widens the cap and surfaces a subtle filename
 * caption; a set keeps names in the tooltip + aria-label only.
 */
function ImageTile({
  artifact,
  index,
  single,
  onOpenArtifact,
  onOpen,
  srcOf,
}: {
  artifact: ArtifactRef;
  index: number;
  single: boolean;
  onOpenArtifact?: (artifact: ArtifactRef) => void;
  onOpen?: (index: number) => void;
  srcOf: (hash: string) => string;
}) {
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);

  if (broken) {
    return <FileRow artifact={artifact} onOpenArtifact={onOpenArtifact} srcOf={srcOf} />;
  }

  const tile = (
    <button
      type="button"
      onClick={() => (onOpenArtifact ? onOpenArtifact(artifact) : onOpen?.(index))}
      className={cn("p-0", tileFrameClass(single))}
      aria-label={`open image ${index + 1}${artifact.name ? `: ${artifact.name}` : ""}`}
      title={artifact.name}
    >
      {loaded ? null : <span aria-hidden className="skeleton absolute inset-0" />}
      <img
        src={srcOf(artifact.hash)}
        alt={artifact.name ?? `image ${index + 1}`}
        onLoad={() => setLoaded(true)}
        onError={() => setBroken(true)}
        className={cn(tileImageClass(single), loaded ? "opacity-100" : "opacity-0")}
      />
    </button>
  );

  // A single image carries a subtle truncated filename below it (room to scan); a set keeps the name
  // in the tooltip/aria-label only so a grid of tiles doesn't turn noisy. The caption never widens
  // the transcript - it truncates.
  if (single && artifact.name) {
    return (
      <div className="flex w-fit max-w-full flex-col items-start gap-1">
        {tile}
        <span
          className="block max-w-[24rem] truncate text-label text-muted-foreground"
          title={artifact.name}
        >
          {artifact.name}
        </span>
      </div>
    );
  }

  return tile;
}

export function MessageImages({
  images,
  others,
  onOpenArtifact,
  onOpen,
  srcOf = artifactSrc,
  className,
}: MessageImagesProps) {
  if (images.length === 0 && others.length === 0) {
    return null;
  }

  const single = images.length === 1;

  return (
    // `@container` so the image set lays out by THIS block's width, not the viewport (the ancestor a
    // container query needs - the section below reads it).
    <div className={cn("@container flex flex-col gap-2", className)}>
      {images.length > 0 ? (
        <section
          className={cn(
            // Mobile-width container: a tidy two-column grid (tiles fill their column). At tablet
            // width it switches to a flex row that wraps the shorter tiles. A single image opts out
            // of the grid so it can use the taller cap and full width.
            single ? "block" : "grid grid-cols-2 items-start gap-2 @md:flex @md:flex-wrap",
          )}
          aria-label="message images"
        >
          {images.map((artifact, i) => (
            <ImageTile
              key={artifact.hash}
              artifact={artifact}
              index={i}
              single={single}
              onOpenArtifact={onOpenArtifact}
              onOpen={onOpen}
              srcOf={srcOf}
            />
          ))}
        </section>
      ) : null}

      {others.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {others.map((artifact) => (
            <FileRow
              key={artifact.hash}
              artifact={artifact}
              onOpenArtifact={onOpenArtifact}
              srcOf={srcOf}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
