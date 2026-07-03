/**
 * Responsible for: detecting the active `@`-file-mention token under the caret - a pure function over
 * (text, caret) so the trigger rule (start-of-draft / whitespace / open-punctuation boundary, no
 * emails, no mid-word `@`, no shell lane) is unit-tested without a DOM or React. Returns the token's
 * `@`..end span and its query body, or null when the caret is not inside an openable mention.
 * Not for: the menu state, key handling, or insertion (use-file-mention-menu.ts owns those), and not
 * for filesystem search (the host owns that).
 */

import { isMentionBoundaryBefore } from "@trevor/session";

/** An active `@`-mention token: the `[start, end)` span of `@<query>` and the query body after `@`. */
export interface ActiveMention {
  /** The `@` character index (inclusive) - the start of the replaceable token. */
  readonly start: number;
  /** The index just past the token (exclusive): the next whitespace, or the end of the text. */
  readonly end: number;
  /** The token body after `@` (may contain `/`, `.`, `-`, `_`; never whitespace). The search query. */
  readonly query: string;
}

/**
 * The active `@`-mention token the caret sits inside, or null. The caret must be strictly after an
 * `@` that opens a whitespace-delimited word at a safe boundary; the token runs to the next
 * whitespace. Emails (`joe@work`), mid-word `@`, and the shell lane (a leading `!`) never open one.
 */
export function activeMention(text: string, caret: number): ActiveMention | null {
  // The shell lane (D-082): the whole composer is a literal `!command`, never a prompt with mentions.
  if (text[0] === "!") {
    return null;
  }
  const cursor = Math.max(0, Math.min(caret, text.length));
  // Walk left from the caret through token-body characters until the `@` that opens the token; stop
  // (no mention) at the first whitespace or the start of the text.
  let start = cursor - 1;
  while (start >= 0) {
    const ch = text[start];
    if (ch === undefined || /\s/u.test(ch)) {
      return null;
    }
    if (ch === "@") {
      break;
    }
    start -= 1;
  }
  if (start < 0 || text[start] !== "@" || !isMentionBoundaryBefore(text, start)) {
    return null;
  }
  // The token extends right from `@` to the next whitespace (or the end of the text).
  let end = start + 1;
  while (end < text.length) {
    const ch = text[end];
    if (ch === undefined || /\s/u.test(ch)) {
      break;
    }
    end += 1;
  }
  return { start, end, query: text.slice(start + 1, end) };
}
