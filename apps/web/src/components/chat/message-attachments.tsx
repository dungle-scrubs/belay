import type { ArtifactRef } from "@trevor/session";
import { useState } from "react";
import { partitionArtifacts } from "@/derive";
import { ImageCarousel } from "./image-carousel";
import { MessageImages } from "./message-images";

/**
 * A submitted user message's attachments (D-092 M4+M5): the inline image set, wired to the
 * same-message carousel. Clicking any image opens the carousel scoped to THIS message's images at
 * the clicked index. The transcript renders one of these per user message; carousel state is local
 * so each message owns its own viewer.
 */

export interface MessageAttachmentsProps {
  readonly artifacts: readonly ArtifactRef[];
  readonly srcOf?: (hash: string) => string;
  readonly className?: string;
}

export function MessageAttachments({ artifacts, srcOf, className }: MessageAttachmentsProps) {
  const { images } = partitionArtifacts(artifacts);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  const openAt = (i: number) => {
    setIndex(i);
    setOpen(true);
  };

  return (
    <>
      <MessageImages artifacts={artifacts} onOpen={openAt} srcOf={srcOf} className={className} />
      {images.length > 0 ? (
        <ImageCarousel
          images={images}
          open={open}
          initialIndex={index}
          onOpenChange={setOpen}
          srcOf={srcOf}
        />
      ) : null}
    </>
  );
}
