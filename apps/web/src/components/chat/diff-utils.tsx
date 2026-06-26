import { createTwoFilesPatch, diffLines } from "diff";

/**
 * Pads a bare snippet with a trailing newline so `createTwoFilesPatch` omits the
 * "\ No newline at end of file" marker that otherwise renders as noise. An empty
 * side (a freshly written file's "before") stays empty so the patch is all additions.
 */
export const withNewline = (text: string): string =>
  text === "" || text.endsWith("\n") ? text : `${text}\n`;

/** A prepared edit ready to render: the unified patch plus its +/- line counts. */
export interface ToolDiff {
  readonly patch: string;
  readonly added: number;
  readonly removed: number;
}

/**
 * Prepares one before/after edit for display (D-015): the single owner of `createTwoFilesPatch` +
 * `withNewline` + `countChanges`, returning the unified `patch` and its `{ added, removed }` line
 * counts together so a renderer never re-derives one from the other. `path` names both sides of the
 * patch header; `context` is the lines of unchanged surrounding context (tool-diff uses 3, multi_edit
 * 2). `DiffViewer` consumes the `patch` as a pure display component.
 */
export function generateToolDiff(
  path: string,
  oldText: string,
  newText: string,
  context: number,
): ToolDiff {
  const patch = createTwoFilesPatch(
    path,
    path,
    withNewline(oldText),
    withNewline(newText),
    undefined,
    undefined,
    { context },
  );
  const { added, removed } = countChanges(oldText, newText);
  return { patch, added, removed };
}

/** Added/removed line counts between two texts, for a `+N -M` stat on a diff. */
export function countChanges(oldText: string, newText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;

  for (const part of diffLines(oldText, newText)) {
    const lines = part.count ?? 0;

    if (part.added) {
      added += lines;
    } else if (part.removed) {
      removed += lines;
    }
  }

  return { added, removed };
}

/** The `+N -M` stat node shared by every diff renderer's section header. */
export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <>
      <span className="text-smui-green">+{added}</span>{" "}
      <span className="text-smui-red">-{removed}</span>
    </>
  );
}
