import type { ToolScriptArtifact } from "@trevor/session";
import { shortSha16 } from "./hash";

/**
 * Output bounding for `tool_script` (plan 16, M6). A bridge tool can return a LOT (a big file, a wide
 * search); handing that straight to the script would flood its context and the transcript. So a bridge
 * output past the per-call budget is SUMMARIZED to a bounded artifact ref - an id, the original byte count,
 * and a short preview - and the full content is carried NOWHERE. The final result is likewise size-checked
 * so a script cannot return an unbounded blob.
 */

const ARTIFACT_PREVIEW_BYTES = 512;

export interface SummarizedOutput {
  /** The string handed back to the script: a JSON artifact ref when summarized, else the raw output. */
  readonly output: string;
  /** The artifact record when summarized (for the detail view); undefined when the output passed through. */
  readonly artifact?: ToolScriptArtifact;
}

/** The longest prefix of `str` whose UTF-8 encoding is at most `maxBytes`, cut on a character boundary
 *  (never splitting a multibyte code point). Keeps a "bounded" preview genuinely bounded in BYTES. */
function sliceToBytes(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str) <= maxBytes) {
    return str;
  }
  let end = 0;
  let used = 0;
  for (const ch of str) {
    const chBytes = Buffer.byteLength(ch);
    if (used + chBytes > maxBytes) {
      break;
    }
    used += chBytes;
    end += ch.length;
  }
  return str.slice(0, end);
}

/**
 * Returns `output` unchanged when it is within `maxBytes`; otherwise a bounded artifact ref (id + original
 * byte count + a capped preview). The output is measured in BYTES, so the preview is byte-bounded too (a
 * multibyte string must not slip a preview larger than the budget past the cap). Full content is never kept.
 */
export function summarizeToolOutput(output: string, maxBytes: number): SummarizedOutput {
  const bytes = Buffer.byteLength(output);
  if (bytes <= maxBytes) {
    return { output };
  }
  const artifact: ToolScriptArtifact = {
    kind: "artifact",
    artifactId: `script_art_${shortSha16(output)}`,
    originalBytes: bytes,
    preview: sliceToBytes(output, Math.min(ARTIFACT_PREVIEW_BYTES, maxBytes)),
  };
  return { output: JSON.stringify(artifact), artifact };
}

/** Whether a final script result serializes within the result-byte budget. */
export function resultWithinBudget(result: unknown, maxBytes: number): boolean {
  return Buffer.byteLength(JSON.stringify(result) ?? "") <= maxBytes;
}
