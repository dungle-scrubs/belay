import type { LucidAnchor, LucidDeliveredAnnotation, LucidReviewStatus } from "./lucid";

/**
 * External LUCID CLI compatibility (plan 27, M8). Trevor renders Lucid artifacts natively in its
 * artifact panel, but a session authored by the standalone `~/dev/lucid` CLI has a different on-disk
 * shape: a co-located append-only NDJSON event log (`.lucid/<name>/log.ndjson`) whose anchors follow
 * `~/dev/lucid/src/anchors/anchor.ts`. This module ADAPTS that external shape into Trevor's structured
 * Lucid feedback WITHOUT depending on or running the lucid CLI, and re-states lucid's anchor CONTRACT
 * so a committed fixture can be validated against it - proving Trevor's integration reads lucid output
 * faithfully and never mutates it (the CLI contract stays intact).
 *
 * The external types below MIRROR `~/dev/lucid` exactly (it is not a dependency); they are the
 * fixture-validated contract, distinct from Trevor's own `LucidAnchor` (see `lucid.ts`).
 */

/** The external lucid ELEMENT anchor (mirrors lucid `ElementAnchor`). */
export interface LucidExternalElementAnchor {
  readonly kind: "element";
  readonly lucidId?: string;
  readonly fingerprint: string;
  readonly domPath: string;
  readonly snippet: string;
}

/** The external lucid RANGE anchor (mirrors lucid `RangeAnchor`): nested quote + position, snippet on
 *  the anchor - deliberately different from Trevor's flattened {@link LucidAnchor}. */
export interface LucidExternalRangeAnchor {
  readonly kind: "range";
  readonly quote: { readonly exact: string; readonly prefix: string; readonly suffix: string };
  readonly position: { readonly start: number; readonly end: number };
  readonly snippet: string;
}

export type LucidExternalAnchor = LucidExternalElementAnchor | LucidExternalRangeAnchor;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isString = (v: unknown): v is string => typeof v === "string";
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Validates an external lucid anchor against the CLI contract (a faithful re-statement of lucid's
 * `parseAnchor`). Used by the M8 test to prove a committed fixture conforms to lucid's output shape,
 * and that Trevor's import leaves that shape valid.
 */
export function isValidLucidExternalAnchor(input: unknown): input is LucidExternalAnchor {
  if (!isRecord(input)) {
    return false;
  }
  if (input.kind === "element") {
    return (
      isString(input.fingerprint) &&
      isString(input.domPath) &&
      isString(input.snippet) &&
      (input.lucidId === undefined || isString(input.lucidId))
    );
  }
  if (input.kind === "range") {
    const quote = input.quote;
    const position = input.position;
    return (
      isRecord(quote) &&
      isString(quote.exact) &&
      isString(quote.prefix) &&
      isString(quote.suffix) &&
      isRecord(position) &&
      isFiniteNumber(position.start) &&
      isFiniteNumber(position.end) &&
      isString(input.snippet)
    );
  }
  return false;
}

/** Adapts an external lucid anchor to Trevor's {@link LucidAnchor} + its addressed snippet. Pure and
 *  total; it never reshapes the input, so the caller's fixture is untouched. */
export function adaptLucidAnchor(anchor: LucidExternalAnchor): {
  readonly anchor: LucidAnchor;
  readonly snippet: string;
} {
  if (anchor.kind === "range") {
    return {
      anchor: {
        type: "range",
        quote: anchor.quote.exact,
        ...(anchor.quote.prefix ? { prefix: anchor.quote.prefix } : {}),
        ...(anchor.quote.suffix ? { suffix: anchor.quote.suffix } : {}),
        start: anchor.position.start,
        end: anchor.position.end,
      },
      snippet: anchor.snippet,
    };
  }
  return {
    anchor: {
      type: "element",
      ...(anchor.lucidId ? { lucidId: anchor.lucidId } : {}),
      fingerprint: anchor.fingerprint,
      domPath: anchor.domPath,
    },
    snippet: anchor.snippet,
  };
}

/** The Trevor-native projection of an imported external lucid session: what the artifact panel needs
 *  to render + review it. */
export interface ImportedLucidSession {
  readonly lucidId: string;
  readonly version: number;
  readonly reviewStatus: LucidReviewStatus;
  readonly title?: string;
  readonly htmlHash?: string;
  readonly annotations: readonly LucidDeliveredAnnotation[];
}

/** The stable Trevor lucidId for an external session file path (its basename without extension). */
export function lucidIdFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "") || base;
}

/**
 * Imports a `~/dev/lucid` NDJSON event log into a Trevor-native {@link ImportedLucidSession}: it folds
 * `session_opened`/`version` for the artifact identity + latest version, `annotation` events into
 * structured Trevor annotations (adapting the anchors), and `review_resolved`/`review_reopened` into
 * the review status. Torn-tail tolerant (a garbled trailing line is skipped, like lucid's own fold).
 * Never runs or requires the lucid CLI. Pure.
 */
export function importLucidSession(ndjson: string): ImportedLucidSession {
  let lucidId = "imported";
  let title: string | undefined;
  let version = 1;
  let htmlHash: string | undefined;
  let reviewStatus: LucidReviewStatus = "open";
  const annotations: LucidDeliveredAnnotation[] = [];

  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed);
      if (!isRecord(parsed)) {
        continue;
      }
      event = parsed;
    } catch {
      continue; // torn trailing line / non-JSON - skip, never throw
    }
    if (event.t === "session_opened") {
      if (isString(event.path)) {
        lucidId = lucidIdFromPath(event.path);
        title = lucidIdFromPath(event.path);
      }
      if (isFiniteNumber(event.version)) {
        version = Math.max(version, event.version);
      }
      if (isString(event.hash)) {
        htmlHash = event.hash;
      }
    } else if (event.t === "version") {
      if (isFiniteNumber(event.version)) {
        version = Math.max(version, event.version);
      }
      if (isString(event.hash)) {
        htmlHash = event.hash;
      }
    } else if (event.t === "annotation" && isValidLucidExternalAnchor(event.target)) {
      const { anchor, snippet } = adaptLucidAnchor(event.target);
      annotations.push({
        annotationId: isString(event.id) ? event.id : `imported-${annotations.length}`,
        anchor,
        snippet,
        note: isString(event.note) ? event.note : "",
      });
    } else if (event.t === "review_resolved") {
      reviewStatus = "resolved";
    } else if (event.t === "review_reopened") {
      reviewStatus = "open";
    }
  }

  return {
    lucidId,
    version,
    reviewStatus,
    ...(title ? { title } : {}),
    ...(htmlHash ? { htmlHash } : {}),
    annotations,
  };
}
