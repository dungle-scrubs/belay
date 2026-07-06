import { spaceAfter, spaceBefore } from "./token-spacing";

/**
 * The generic positional-token draft engine (deepen C-17): the shared insert / atomic-remove /
 * reconcile / renumber core BOTH composer token kinds are built from - the inline `[Image #N]` tokens
 * paired with uploaded refs and the `[Pasted text #N +M lines]` tokens paired with exact pasted
 * payloads. A token stands for the payload at its reading-order position; the displayed number is
 * purely positional, so any edit that changes the token set is reconciled by mapping the SURVIVING
 * tokens back through their OLD numbers, then renumbering to 1..K reading order.
 *
 * This module is pure - no DOM, no React - so the positional-renumber / adjacent-remove / old-number->
 * payload invariants live and are unit-tested ONCE here (through the two token suites that drive it),
 * and a new token kind is a single {@link TokenCodec}, not a third copy of this logic. The token FORMAT
 * (the parser + the token text) is the cross-surface contract owned by `@trevor/session`; a codec just
 * names which format this engine is editing.
 */

/** A parsed token: its char span and its (positional) display number. A codec's span may carry more
 *  (a paste token also carries its `+M` line count), which {@link TokenCodec.render} reads back. */
export interface PositionalToken {
  readonly start: number;
  readonly end: number;
  readonly num: number;
}

/**
 * The per-kind format adapter. `parse` finds a kind's tokens in reading order; `render` re-emits a
 * token at a new number, taking the parsed SPAN so a kind whose token text carries extra display
 * attributes (a paste token's `+M lines`) preserves them across a renumber; `renderNew` mints a fresh
 * token for an inserted payload - its number is a placeholder the next renumber overwrites, but its
 * display attributes are real (derived from the payload).
 */
export interface TokenCodec<Payload, Span extends PositionalToken> {
  parse(text: string): Span[];
  render(num: number, span: Span): string;
  renderNew(payload: Payload): string;
}

/** A draft: the visible tokens in `text` paired with their payloads in reading order. */
export interface TokenDraft<Payload> {
  readonly text: string;
  readonly payloads: readonly Payload[];
}

/** An insert/remove result: the new draft plus where the cursor lands. */
export interface TokenDraftEdit<Payload> {
  readonly draft: TokenDraft<Payload>;
  readonly cursor: number;
}

/** Binds the shared draft operations to one token kind's {@link TokenCodec}. */
export function positionalTokenDraft<Payload, Span extends PositionalToken>(
  codec: TokenCodec<Payload, Span>,
) {
  /** Rewrites every token's number to its reading-order position (1..K), preserving each token's other
   *  display attributes and all surrounding text. */
  function renumber(text: string): string {
    let out = "";
    let last = 0;
    let n = 0;
    for (const span of codec.parse(text)) {
      out += text.slice(last, span.start) + codec.render(++n, span);
      last = span.end;
    }
    return out + text.slice(last);
  }

  /** The payloads for the tokens inside a text slice, mapped from a source draft by their old numbers. */
  function payloadsIn(slice: string, source: TokenDraft<Payload>): Payload[] {
    return codec
      .parse(slice)
      .map((span) => source.payloads[span.num - 1])
      .filter((p): p is Payload => p !== undefined);
  }

  /** The char index just after the reading-order `index`-th token (end of string if absent). */
  function endOfToken(text: string, index: number): number {
    const span = codec.parse(text)[index];
    return span ? span.end : text.length;
  }

  /**
   * Inserts `payloads` as tokens at the selection `[selStart, selEnd)` (replacing it), auto-spacing so
   * the tokens never abut adjacent words and splicing the payloads into reading order at the insertion
   * point. Returns the new draft and the cursor just after the last inserted token; a no-op (cursor at
   * `selStart`) when `payloads` is empty.
   */
  function insert(
    draft: TokenDraft<Payload>,
    selStart: number,
    selEnd: number,
    payloads: readonly Payload[],
  ): TokenDraftEdit<Payload> {
    if (payloads.length === 0) {
      return { draft, cursor: selStart };
    }
    const before = draft.text.slice(0, selStart);
    const after = draft.text.slice(selEnd);
    const payloadsBefore = payloadsIn(before, draft);
    const payloadsAfter = payloadsIn(after, draft);
    const next = [...payloadsBefore, ...payloads, ...payloadsAfter];

    // Placeholder numbers are irrelevant - renumber rewrites every token positionally; only each
    // token's display attributes (carried by renderNew) are meaningful.
    const placeholders = payloads.map((p) => codec.renderNew(p)).join(" ");
    const rawText = `${before}${spaceBefore(before)}${placeholders}${spaceAfter(after)}${after}`;
    const text = renumber(rawText);

    const lastInsertedIndex = payloadsBefore.length + payloads.length - 1;
    const tokenEnd = endOfToken(text, lastInsertedIndex);
    const cursor = tokenEnd + (spaceAfter(after) ? 1 : 0);
    return { draft: { text, payloads: next }, cursor };
  }

  /**
   * Removes the reading-order `index`-th token AND its paired payload, collapsing a now-redundant
   * double space, then renumbers the survivors. A no-op when no such token exists.
   */
  function removeAt(draft: TokenDraft<Payload>, index: number): TokenDraft<Payload> {
    const span = codec.parse(draft.text)[index];
    if (!span) {
      return draft;
    }
    const { start } = span;
    let { end } = span;
    // Collapse "word [token] word" -> "word word" rather than leaving a double space.
    if (draft.text[start - 1] === " " && draft.text[end] === " ") {
      end += 1;
    }
    const rawText = draft.text.slice(0, start) + draft.text.slice(end);
    const payloads = draft.payloads.filter((_, i) => i !== index);
    return { text: renumber(rawText), payloads };
  }

  /**
   * Backspace (`dir = -1`) or Delete (`dir = 1`) next to a whole token removes the token + its payload
   * atomically. Returns the new draft + cursor, or `null` when no token is immediately adjacent (so the
   * textarea handles the keystroke normally).
   */
  function removeAdjacent(
    draft: TokenDraft<Payload>,
    cursor: number,
    dir: -1 | 1,
  ): TokenDraftEdit<Payload> | null {
    const spans = codec.parse(draft.text);
    const index = spans.findIndex((span) =>
      dir === -1 ? span.end === cursor : span.start === cursor,
    );
    const span = spans[index];
    if (index === -1 || !span) {
      return null;
    }
    return { draft: removeAt(draft, index), cursor: span.start };
  }

  /**
   * Reconciles a draft after an arbitrary raw text edit (a selection delete/replace, a paste): the
   * surviving tokens keep their OLD numbers in `rawText`, so each is mapped back to the payload it had,
   * then the result is renumbered to reading order. A token whose number no longer maps to a payload
   * (literal text the user typed) is dropped, keeping `payloads.length` equal to the token count.
   */
  function sync(prevPayloads: readonly Payload[], rawText: string): TokenDraft<Payload> {
    let out = "";
    let last = 0;
    let n = 0;
    const payloads: Payload[] = [];
    for (const span of codec.parse(rawText)) {
      const payload = prevPayloads[span.num - 1];
      out += rawText.slice(last, span.start);
      if (payload) {
        out += codec.render(++n, span);
        payloads.push(payload);
      }
      // A token with no mapped payload is dropped (we never author literal tokens).
      last = span.end;
    }
    return { text: out + rawText.slice(last), payloads };
  }

  return { renumber, insert, removeAt, removeAdjacent, sync };
}
