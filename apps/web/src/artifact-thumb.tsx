import type { ArtifactRef } from "@trevor/session";
import { useState } from "react";
import { artifactSrc } from "./blob";

/**
 * Renders an attached artifact as an image thumbnail, falling back to a file link if it
 * can't be decoded (a non-image, or an unexpected format the browser can't render) - so a
 * broken-image icon never shows. `square` crops to a fixed size for compact chips; the
 * default is a contained thumbnail up to `size`.
 */
export function ArtifactThumb({
  artifact,
  size = 240,
  square = false,
}: {
  artifact: ArtifactRef;
  size?: number;
  square?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  if (artifact.kind === "image" && !broken) {
    return (
      <img
        src={artifactSrc(artifact.hash)}
        alt={artifact.name ?? "attachment"}
        onError={() => setBroken(true)}
        style={
          square
            ? { width: size, height: size, objectFit: "cover", borderRadius: 4 }
            : { maxWidth: size, maxHeight: size, borderRadius: 6, border: "1px solid #eee" }
        }
      />
    );
  }
  return (
    <a
      href={artifactSrc(artifact.hash)}
      target="_blank"
      rel="noreferrer"
      style={{ fontSize: "0.8rem" }}
    >
      📄 {artifact.name ?? artifact.kind}
    </a>
  );
}
