/** A parsed span: a `[start, end)` range over the source string. Callers pass sorted, non-overlapping spans. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * Covers the whole string, calling `renderSpan` for each sorted, non-overlapping span and `renderGap`
 * for the plain runs between and around them (including the trailing run). The single owner of the
 * "highlight the spans, plain text in the gaps" interleave the composer's token overlays (image / paste
 * chips) and the loop command input (colored command tokens) all walk, so the cover-the-string
 * invariant is stated once instead of re-implemented per surface. Pure - the caller decides what a span
 * and a gap render to (a React node, a data segment), so it serves both the DOM overlays and the plain
 * segment model.
 */
export function segmentBySpans<S extends Span, T>(
  value: string,
  spans: readonly S[],
  renderSpan: (span: S, index: number) => T,
  renderGap: (text: string, at: number) => T,
): T[] {
  const out: T[] = [];
  let last = 0;
  spans.forEach((span, index) => {
    if (span.start > last) {
      out.push(renderGap(value.slice(last, span.start), last));
    }
    out.push(renderSpan(span, index));
    last = span.end;
  });
  if (last < value.length) {
    out.push(renderGap(value.slice(last), last));
  }
  return out;
}
