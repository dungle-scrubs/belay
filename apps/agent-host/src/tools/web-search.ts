import { Effect, Layer, Schema } from "effect";
import {
  FRESHNESS,
  type Freshness,
  formatError,
  HttpClientLive,
  SettingsLive,
  type WebSearchResponse,
  webSearch,
} from "web-search";
import { ToolExecutionError } from "./errors";
import { defineTool } from "./shared";

// web-search resolves credentials from process.env (BRAVE_API_KEY, then
// SERPER_API_KEY) and fetches over the global fetch, so both service layers are
// fully self-contained - nothing else needs to be provided to run the search.
const PROVIDED = Layer.merge(HttpClientLive, SettingsLive);

const Params = Schema.Struct({
  query: Schema.String.annotations({ description: "The search query" }),
  // `count` decodes leniently (any number): web-search's boundedCount clamps it to [1, 20]
  // and treats a non-integer as the default, preserving the old tool's behavior. The
  // advertised JSON Schema still presents it as a bounded integer (the model-facing hint).
  count: Schema.optional(
    Schema.Number.annotations({ jsonSchema: { type: "integer", minimum: 1, maximum: 20 } }),
  ).annotations({
    description: "Number of results to return, clamped to [1, 20] (default 10)",
  }),
  freshness: Schema.optional(Schema.Literal(...FRESHNESS)).annotations({
    description: "Restrict to results from the last day, week, month, or year (Brave only)",
  }),
});

/**
 * Serializes a search response as compact JSON: one form the model reads (clean,
 * precise fields for follow-up tool use) and the web renders (the web_search tool
 * card). The shared output cap is applied by the tool primitive; the web parses it defensively.
 */
function renderResponse(
  query: string,
  freshness: Freshness | undefined,
  response: WebSearchResponse,
): string {
  return JSON.stringify({
    provider: response.provider,
    query,
    ...(freshness ? { freshness } : {}),
    results: response.results.map((source) => ({
      title: source.title,
      url: source.url,
      snippet: source.snippet,
      published: source.published,
    })),
  });
}

/** Searches the web via Brave (Serper fallback) and returns normalized results. */
export const webSearchTool = defineTool({
  name: "web_search",
  description:
    "Search the web via Brave, falling back to Serper. Use for current events, " +
    "documentation, library versions, or any fact not in the workspace. Requires " +
    "BRAVE_API_KEY or SERPER_API_KEY in the host environment. Returns JSON: " +
    "{provider, query, results: [{title, url, snippet, published}]}.",
  params: Params,
  readOnly: true,
  capped: true,
  execute: (args) => {
    const { query, count, freshness } = args;
    return webSearch({ query, count, freshness }).pipe(
      Effect.provide(PROVIDED),
      Effect.map((response) => renderResponse(query.trim(), freshness, response)),
      Effect.mapError(
        (error) => new ToolExecutionError({ tool: "web_search", detail: formatError(error) }),
      ),
    );
  },
});
