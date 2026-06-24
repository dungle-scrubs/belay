import { diffLines } from "diff";

/**
 * Pads a bare snippet with a trailing newline so `createTwoFilesPatch` omits the
 * "\ No newline at end of file" marker that otherwise renders as noise. An empty
 * side (a freshly written file's "before") stays empty so the patch is all additions.
 */
export const withNewline = (text: string): string =>
  text === "" || text.endsWith("\n") ? text : `${text}\n`;

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
