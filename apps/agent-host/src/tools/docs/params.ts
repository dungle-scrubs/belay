/**
 * The docs tool's model-facing param contract: the action + argument schema the tool advertises, the
 * numeric caps that schema promises, and the lenient clamp that enforces them in code. The schema is
 * what the model sees; the clamp is what the runtime guarantees, so an out-of-range or non-integer
 * argument degrades to the documented bounds instead of erroring the turn.
 *
 * Responsible for: the docs param contract - the DocsParams schema, its advertised caps, and the
 * lenient clamp.
 * Not for: routing or executing actions - docs.ts routes; build-actions.ts / query-actions.ts execute.
 */

import { Schema } from "effect";
import { DOCS_ACTIONS } from "./envelope";

export const MAX_PAGES_FLOOR = 1;
export const MAX_PAGES_CEILING = 200;
export const DEFAULT_MAX_PAGES = 40;

export const MAX_RESULTS_FLOOR = 1;
export const MAX_RESULTS_CEILING = 50;
export const DEFAULT_MAX_RESULTS = 8;

export const DocsParams = Schema.Struct({
  action: Schema.Literal(...DOCS_ACTIONS).annotations({
    description:
      "What to do: 'resolve' (find/build a corpus for a subject), 'refresh' (re-fetch a stale " +
      "corpus), 'search' (query within a corpus), 'read' (read one cached page), 'list' (known " +
      "corpora), or 'status' (a corpus's freshness/coverage).",
  }),
  subject: Schema.optional(Schema.String).annotations({
    description:
      "The product/API/library/SDK/service to look up docs for (resolve/refresh/search).",
  }),
  url: Schema.optional(Schema.String).annotations({
    description: "A known documentation root or page URL to anchor resolution to (optional).",
  }),
  query: Schema.optional(Schema.String).annotations({
    description: "The question to answer from a corpus (search).",
  }),
  pageId: Schema.optional(Schema.String).annotations({
    description: "A specific cached page id to read (read).",
  }),
  corpusId: Schema.optional(Schema.String).annotations({
    description: "Target an existing corpus by id (refresh/search/read/status).",
  }),
  version: Schema.optional(Schema.String).annotations({
    description: "Pin a documented product/library version for resolution (optional).",
  }),
  // maxPages/maxResults decode leniently (any number) and are clamped in code; the advertised schema
  // still presents them as bounded integers (the model-facing hint), like web_fetch's caps.
  maxPages: Schema.optional(
    Schema.Number.annotations({
      jsonSchema: { type: "integer", minimum: MAX_PAGES_FLOOR, maximum: MAX_PAGES_CEILING },
    }),
  ).annotations({
    description: `Cap on pages a resolve/refresh may gather, clamped to [${MAX_PAGES_FLOOR}, ${MAX_PAGES_CEILING}] (default ${DEFAULT_MAX_PAGES})`,
  }),
  maxResults: Schema.optional(
    Schema.Number.annotations({
      jsonSchema: { type: "integer", minimum: MAX_RESULTS_FLOOR, maximum: MAX_RESULTS_CEILING },
    }),
  ).annotations({
    description: `Cap on search excerpts returned, clamped to [${MAX_RESULTS_FLOOR}, ${MAX_RESULTS_CEILING}] (default ${DEFAULT_MAX_RESULTS})`,
  }),
  offset: Schema.optional(
    Schema.Number.annotations({ jsonSchema: { type: "integer", minimum: 0 } }),
  ).annotations({
    description:
      "Continuation cursor from a prior result's window.nextOffset (search/read/list), to page " +
      "past a capped result.",
  }),
  allowRefresh: Schema.optional(Schema.Boolean).annotations({
    description:
      "On resolve, re-fetch even when the cached corpus is still fresh (default false: a fresh " +
      "corpus is reused without any network call).",
  }),
  allowStale: Schema.optional(Schema.Boolean).annotations({
    description:
      "Serve cached content without a network refresh; past its freshness window it is returned " +
      "marked stale rather than re-fetched (default false).",
  }),
});

export type DocsArgs = typeof DocsParams.Type;

// The lenient clamp itself lives in tools/shared (web_fetch enforces its caps with the same one);
// re-exported here because it is part of this param contract - the runtime guarantee behind the
// advertised bounds.
export { clamp } from "../shared";
