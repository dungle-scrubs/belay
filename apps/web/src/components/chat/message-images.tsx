import type { ArtifactRef } from "@trevor/session";
import { FileText } from "lucide-react";
import { useState } from "react";
import { artifactSrc } from "@/blob";
import { cn } from "@/lib/utils";

/**
 * The user-message image set (D-092 M4): renders the images attached to a submitted prompt in the
 * SAME transcript item as the text, at natural dimensions until a responsive max width/height caps
 * them, contained (never cropped) so aspect ratio is preserved. Multiple images form one set for
 * layout and the same-message carousel (clicking any image calls `onOpen` with its set index).
 * A broken/missing/non-image artifact degrades to a quiet file/link row - never a broken-image icon.
 */

export interface MessageImagesProps {
  /** The message's image artifacts, rendered inline as a set (already partitioned by the caller). */
  readonly images: readonly ArtifactRef[];
  /** The message's non-image artifacts, rendered as quiet file/link rows (already partitioned). */
  readonly others: readonly ArtifactRef[];
  /** Opens the same-message carousel at the given image-set index (M5). */
  readonly onOpen?: (index: number) => void;
  /** Resolves a hash to an image URL; defaults to the blob-store `artifactSrc`. */
  readonly srcOf?: (hash: string) => string;
  readonly className?: string;
}

/** A quiet file/link row for a document, non-image, or image that failed to load (no broken icon). */
function FileRow({ artifact, srcOf }: { artifact: ArtifactRef; srcOf: (hash: string) => string }) {
  return (
    <a
      href={srcOf(artifact.hash)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 border border-border bg-card px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <FileText className="size-3.5 shrink-0" />
      <span className="max-w-[16rem] truncate">{artifact.name ?? artifact.kind}</span>
    </a>
  );
}

/** One image tile - natural size up to the responsive cap, contained, click-to-open; falls back on error. */
function ImageTile({
  artifact,
  index,
  single,
  onOpen,
  srcOf,
}: {
  artifact: ArtifactRef;
  index: number;
  single: boolean;
  onOpen?: (index: number) => void;
  srcOf: (hash: string) => string;
}) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return <FileRow artifact={artifact} srcOf={srcOf} />;
  }

  return (
    <button
      type="button"
      onClick={() => onOpen?.(index)}
      className="block cursor-pointer overflow-hidden border border-border bg-card p-0 leading-none"
      aria-label={`open image ${index + 1}${artifact.name ? `: ${artifact.name}` : ""}`}
    >
      <img
        src={srcOf(artifact.hash)}
        alt={artifact.name ?? `image ${index + 1}`}
        onError={() => setBroken(true)}
        // Natural dimensions, capped responsively; contained so nothing is cropped. A single image
        // gets a taller cap; a set uses a shorter cap so the row stays scannable.
        className={cn("h-auto w-auto max-w-full object-contain", single ? "max-h-96" : "max-h-48")}
      />
    </button>
  );
}

export function MessageImages({
  images,
  others,
  onOpen,
  srcOf = artifactSrc,
  className,
}: MessageImagesProps) {
  if (images.length === 0 && others.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {images.length > 0 ? (
        <section className="flex flex-wrap items-start gap-2" aria-label="message images">
          {images.map((artifact, i) => (
            <ImageTile
              key={artifact.hash}
              artifact={artifact}
              index={i}
              single={images.length === 1}
              onOpen={onOpen}
              srcOf={srcOf}
            />
          ))}
        </section>
      ) : null}

      {others.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {others.map((artifact) => (
            <FileRow key={artifact.hash} artifact={artifact} srcOf={srcOf} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
