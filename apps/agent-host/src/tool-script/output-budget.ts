import { createHash } from "node:crypto";
import type { ToolScriptArtifact } from "@trevor/session";

/**
 * Output bounding for `tool_script` (plan 16, M6). A bridge tool can return a LOT (a big file, a wide
 * search); handing that straight to the script would flood its context and the transcript. So a bridge
 * output past the per-call budget is SUMMARIZED to a bounded artifact ref - an id, the original byte count,
 * and a short preview - and the full content is carried NOWHERE. The final result is likewise size-checked
 * so a script cannot return an unbounded blob.
 */

const ARTIFACT_PREVIEW_CHARS = 512;

export interface SummarizedOutput {
  /** The string handed back to the script: a JSON artifact ref when summarized, else the raw output. */
  readonly output: string;
  /** The artifact record when summarized (for the detail view); undefined when the output passed through. */
  readonly artifact?: ToolScriptArtifact;
}

/**
 * Returns `output` unchanged when it is within `maxBytes`; otherwise a bounded artifact ref (id + original
 * byte count + a capped preview). The full content is never included in the returned ref.
 */
export function summarizeToolOutput(output: string, maxBytes: number): SummarizedOutput {
  const bytes = Buffer.byteLength(output);
  if (bytes <= maxBytes) {
    return { output };
  }
  const artifact: ToolScriptArtifact = {
    kind: "artifact",
    artifactId: `script_art_${createHash("sha256").update(output).digest("hex").slice(0, 16)}`,
    originalBytes: bytes,
    preview: output.slice(0, ARTIFACT_PREVIEW_CHARS),
  };
  return { output: JSON.stringify(artifact), artifact };
}

/** Whether a final script result serializes within the result-byte budget. */
export function resultWithinBudget(result: unknown, maxBytes: number): boolean {
  return Buffer.byteLength(JSON.stringify(result) ?? "") <= maxBytes;
}
