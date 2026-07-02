/**
 * The unique-substring replacement shared by `edit` and `multi_edit` - "apply-patch"
 * semantics. `old` must occur exactly once: zero occurrences is a not-found miss, more
 * than one is ambiguous (the model must give a longer, unique anchor). This is the one
 * place that match rule and its user-facing wording live, so `edit` is just the
 * single-item case of the `multi_edit` core and the two cannot drift.
 *
 * It owns only the in-memory match + replace; reading/writing files and confinement stay
 * with the tools. `replace()` uses String.prototype.replace on a known-unique match, so a
 * `$`-sequence in the replacement is interpreted exactly as the tools always did.
 *
 * Responsible for: the unique-substring match + replace rule and its miss wording.
 * Not for: file IO or confinement - edit-core.ts and the edit tools.
 */

export type ReplaceMiss =
  | { readonly reason: "not_found" }
  | { readonly reason: "ambiguous"; readonly count: number };

export type ReplaceResult =
  | { readonly ok: true; readonly content: string }
  | ({
      readonly ok: false;
    } & ReplaceMiss);

/** Replaces the unique occurrence of `oldText` with `newText`, or reports why it could not. */
export function applyUniqueReplacement(
  content: string,
  oldText: string,
  newText: string,
): ReplaceResult {
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) {
    return { ok: false, reason: "not_found" };
  }
  if (occurrences > 1) {
    return { ok: false, reason: "ambiguous", count: occurrences };
  }
  return { ok: true, content: content.replace(oldText, newText) };
}

/** The user-facing error for a missed replacement. `where` (e.g. ` in src/x.ts`) is
 *  appended by `multi_edit`, which edits several files at once; `edit` passes none. */
export function replaceMissMessage(miss: ReplaceMiss, where = ""): string {
  return miss.reason === "not_found"
    ? `error: 'old' text not found${where}`
    : `error: 'old' text appears ${miss.count} times${where} (must be unique)`;
}
