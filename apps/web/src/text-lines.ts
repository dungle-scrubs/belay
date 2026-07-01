/** The index of the first character of the line containing `pos`. */
export function lineStart(value: string, pos: number): number {
  const nl = value.lastIndexOf("\n", Math.max(0, pos - 1));
  return nl === -1 ? 0 : nl + 1;
}

/** The index of the newline ending the line containing `pos`, or the value length. */
export function lineEnd(value: string, pos: number): number {
  const nl = value.indexOf("\n", pos);
  return nl === -1 ? value.length : nl;
}
