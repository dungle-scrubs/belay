import { createHash } from "node:crypto";

/**
 * A short, stable, path-free content hash used across the `tool_script` host side: the script hash on the
 * observability span, the bridge-call input hash, the summarized-artifact id, and the sandbox policy hash.
 * 16 hex chars of SHA-256 - enough to correlate/identify without carrying the raw content anywhere.
 */
export function shortSha16(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
