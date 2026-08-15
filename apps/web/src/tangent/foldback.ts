import type { TangentFoldMode } from "@belay/session";
import { truncate } from "@/derive";

/**
 * Explicit tangent fold-back (plan 37, M8). Fold-back is deliberately NOT an automatic merge: a chosen
 * piece of a tangent's outcome is placed into the PARENT composer as editable, quoted text (via the
 * composer's own quote-into-composer path, so fold-back and Quote never drift) the user reviews and
 * submits (or discards). It never becomes parent prompt history on its own, and never injects hidden
 * context. This module owns the fold-back content shape and the bounded durable-marker preview.
 */

export interface FoldBackContent {
  readonly mode: TangentFoldMode;
  readonly text: string;
}

const PREVIEW_CAP = 200;

/**
 * A bounded, single-line snippet of the folded content for the durable `tangent.foldedBack` marker
 * (observability only) - never the full tangent text, and never fed to a model.
 */
export function foldBackPreview(text: string): string {
  return truncate(text.trim().replace(/\s+/g, " "), PREVIEW_CAP);
}
