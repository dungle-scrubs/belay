import type { LucidAnchor, LucidElementAnchor, LucidRangeAnchor } from "@trevor/session";

/**
 * The CANONICAL Lucid addressability algorithm (plan 27, M4): anchor CAPTURE and RESOLUTION against a
 * live DOM, adapted from `~/dev/lucid`'s W3C-inspired anchor model (element: `data-lucid-id` ->
 * fingerprint -> domPath; range: quote + prefix/suffix -> character position). It runs INSIDE the
 * sandboxed artifact iframe (the only place with the artifact DOM), so it is authored as a single
 * self-contained factory whose inner functions reference only each other and DOM globals. That lets
 * it be BOTH:
 *   - unit-tested here in jsdom (call `lucidAnchorRuntime()` and exercise the returned functions), and
 *   - embedded verbatim into the overlay bootstrap via `String(lucidAnchorRuntime)` (overlay-bootstrap.ts),
 *     so the browser overlay and these tests share ONE implementation and can never drift (the M3
 *     "share overlay code, don't fork" constraint).
 *
 * Resolution NEVER mis-targets: a lost element or an ambiguous/absent quote returns null, and the
 * caller ORPHANS the annotation (surfaces it in the tray) rather than floating it at a stale offset.
 */

/** The DOM half of an anchor resolution: the matched element / character range, or null when the
 *  anchor no longer resolves (the caller then orphans it). */
export type ElementResolution = Element | null;
export type RangeResolution = { readonly start: number; readonly end: number } | null;

export interface LucidAnchorRuntime {
  captureElementAnchor(el: Element): LucidElementAnchor;
  resolveElementAnchor(anchor: LucidElementAnchor, root: ParentNode): ElementResolution;
  captureRangeAnchor(range: Range, root: Node): LucidRangeAnchor | null;
  resolveRangeAnchor(anchor: LucidRangeAnchor, root: Node): RangeResolution;
  /** Whether `id` occurs exactly once as a `data-lucid-id` under `root` (the uniqueness rule that
   *  gates using a lucidId for resolution - a duplicate id falls through to the fingerprint). */
  isUniqueLucidId(root: ParentNode, id: string): boolean;
}

/**
 * Builds the anchor runtime. Authored as a factory of INNER functions (no module-scope value
 * references) so `String(lucidAnchorRuntime)` yields a self-contained, embeddable implementation.
 */
export function lucidAnchorRuntime(): LucidAnchorRuntime {
  const CONTEXT_LEN = 32;

  function normalizeText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  function isUniqueLucidId(root: ParentNode, id: string): boolean {
    if (!id) {
      return false;
    }
    // Attribute values can contain quotes/backslashes; match by scan rather than an unescaped selector.
    let count = 0;
    const all = root.querySelectorAll("*");
    for (let i = 0; i < all.length; i += 1) {
      if (all[i]?.getAttribute("data-lucid-id") === id) {
        count += 1;
        if (count > 1) {
          return false;
        }
      }
    }
    return count === 1;
  }

  function elementFingerprint(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const text = normalizeText(el.textContent ?? "").slice(0, 80);
    const kids: string[] = [];
    const children = el.children;
    for (let i = 0; i < children.length && i < 12; i += 1) {
      const child = children[i];
      if (child) {
        kids.push(child.tagName.toLowerCase());
      }
    }
    return `${tag}|${text}|${kids.join(",")}`;
  }

  function elementDomPath(el: Element): string {
    const segments: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== "html") {
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (!parent) {
        segments.unshift(tag);
        break;
      }
      let index = 1;
      const siblings = parent.children;
      for (let i = 0; i < siblings.length; i += 1) {
        const sib = siblings[i];
        if (sib === node) {
          break;
        }
        if (sib && sib.tagName === node.tagName) {
          index += 1;
        }
      }
      segments.unshift(`${tag}:nth-of-type(${index})`);
      node = parent;
    }
    return segments.join(" > ");
  }

  function captureElementAnchor(el: Element): LucidElementAnchor {
    const rawId = el.getAttribute("data-lucid-id") ?? "";
    const root = el.ownerDocument ?? el;
    const anchor: {
      type: "element";
      lucidId?: string;
      fingerprint?: string;
      domPath?: string;
    } = {
      type: "element",
      fingerprint: elementFingerprint(el),
      domPath: elementDomPath(el),
    };
    if (rawId && isUniqueLucidId(root as unknown as ParentNode, rawId)) {
      anchor.lucidId = rawId;
    }
    return anchor;
  }

  function resolveElementAnchor(anchor: LucidElementAnchor, root: ParentNode): ElementResolution {
    // 1. data-lucid-id, only when unique within the version (a duplicate id falls through).
    if (anchor.lucidId && isUniqueLucidId(root, anchor.lucidId)) {
      const all = root.querySelectorAll("*");
      for (let i = 0; i < all.length; i += 1) {
        const el = all[i];
        if (el?.getAttribute("data-lucid-id") === anchor.lucidId) {
          return el;
        }
      }
    }
    // 2. content+structure fingerprint, only when it matches EXACTLY one element.
    if (anchor.fingerprint) {
      const all = root.querySelectorAll("*");
      let match: Element | null = null;
      let matches = 0;
      for (let i = 0; i < all.length; i += 1) {
        const el = all[i];
        if (el && elementFingerprint(el) === anchor.fingerprint) {
          matches += 1;
          match = el;
          if (matches > 1) {
            break;
          }
        }
      }
      if (matches === 1 && match) {
        return match;
      }
    }
    // 3. structural DOM path.
    if (anchor.domPath) {
      try {
        const el = root.querySelector(anchor.domPath);
        if (el) {
          return el;
        }
      } catch {
        // A malformed/stale path selector never throws out of resolution - it just fails to match.
      }
    }
    return null;
  }

  function rootText(root: Node): string {
    return root.textContent ?? "";
  }

  /** The character offset of (node, nodeOffset) within `root`'s textContent, walking text nodes. */
  function offsetInRoot(root: Node, node: Node, nodeOffset: number): number {
    const doc = root.ownerDocument ?? (root as Document);
    const walker = doc.createTreeWalker(root, 0x4 /* SHOW_TEXT */);
    let total = 0;
    let current = walker.nextNode();
    while (current) {
      if (current === node) {
        return total + nodeOffset;
      }
      total += (current.textContent ?? "").length;
      current = walker.nextNode();
    }
    // The node is not a descendant text node (e.g. selection anchored on an element): best-effort end.
    return total;
  }

  function captureRangeAnchor(range: Range, root: Node): LucidRangeAnchor | null {
    const quote = range.toString();
    if (!quote) {
      return null;
    }
    const start = offsetInRoot(root, range.startContainer, range.startOffset);
    const end = offsetInRoot(root, range.endContainer, range.endOffset);
    const text = rootText(root);
    const prefix = text.slice(Math.max(0, start - CONTEXT_LEN), start);
    const suffix = text.slice(end, end + CONTEXT_LEN);
    const anchor: {
      type: "range";
      quote: string;
      prefix?: string;
      suffix?: string;
      start?: number;
      end?: number;
    } = { type: "range", quote, start, end };
    if (prefix) {
      anchor.prefix = prefix;
    }
    if (suffix) {
      anchor.suffix = suffix;
    }
    return anchor;
  }

  function resolveRangeAnchor(anchor: LucidRangeAnchor, root: Node): RangeResolution {
    const text = rootText(root);
    const quote = anchor.quote;
    if (!quote) {
      return null;
    }
    // 1. quote WITH context (prefix+quote+suffix) - the least ambiguous match.
    const prefix = anchor.prefix ?? "";
    const suffix = anchor.suffix ?? "";
    if (prefix || suffix) {
      const needle = `${prefix}${quote}${suffix}`;
      const at = text.indexOf(needle);
      if (at >= 0 && text.indexOf(needle, at + 1) < 0) {
        const start = at + prefix.length;
        return { start, end: start + quote.length };
      }
    }
    // 2. exact quote, only when it occurs EXACTLY once (ambiguous quote falls through to position).
    const first = text.indexOf(quote);
    if (first >= 0 && text.indexOf(quote, first + 1) < 0) {
      return { start: first, end: first + quote.length };
    }
    // 3. character-position fallback, only when the text at the stored offsets still equals the quote.
    if (
      typeof anchor.start === "number" &&
      typeof anchor.end === "number" &&
      text.slice(anchor.start, anchor.end) === quote
    ) {
      return { start: anchor.start, end: anchor.end };
    }
    return null;
  }

  return {
    captureElementAnchor,
    resolveElementAnchor,
    captureRangeAnchor,
    resolveRangeAnchor,
    isUniqueLucidId,
  };
}

/** Whether an anchor still resolves against `root` - the orphan predicate the panel/overlay share. */
export function anchorResolves(anchor: LucidAnchor, root: Document): boolean {
  const runtime = lucidAnchorRuntime();
  if (anchor.type === "element") {
    return runtime.resolveElementAnchor(anchor, root) !== null;
  }
  return runtime.resolveRangeAnchor(anchor, root) !== null;
}
