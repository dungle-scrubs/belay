/**
 * Writes text to the clipboard, resolving to whether the write succeeded. Returns `false` (never
 * throws/rejects) when there is no clipboard API or the write is denied (permissions/focus), so
 * callers can branch on the result instead of wiring their own try/catch. The single hand-rolled
 * copy path for Trevor code (the vendored assistant-ui markdown copy keeps its own upstream helper).
 */
export async function copyText(value: string): Promise<boolean> {
  const writeText = navigator.clipboard?.writeText;
  if (!writeText) {
    return false;
  }
  try {
    await writeText.call(navigator.clipboard, value);
    return true;
  } catch {
    return false;
  }
}
