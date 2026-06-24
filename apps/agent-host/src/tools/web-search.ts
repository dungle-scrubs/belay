import { Effect, Layer } from "effect";
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
import { cap } from "./shared";
import type { Tool } from "./types";

// web-search resolves credentials from process.env (BRAVE_API_KEY, then
// SERPER_API_KEY) and fetches over the global fetch, so both service layers are
// fully self-contained - nothing else needs to be provided to run the search.
const PROVIDED = Layer.merge(HttpClientLive, SettingsLive);

/**
 * Serializes a search response as compact JSON: one form the model reads (clean,
 * precise fields for follow-up tool use) and the web renders (the web_search tool
 * card). Capped to the shared output limit; the web parses it defensively.
 */
function renderResponse(
  query: string,
  freshness: Freshness | undefined,
  response: WebSearchResponse,
): string {
  return cap(
    JSON.stringify({
      provider: response.provider,
      query,
      ...(freshness ? { freshness } : {}),
      results: response.results.map((source) => ({
        title: source.title,
        url: source.url,
        snippet: source.snippet,
        published: source.published,
      })),
    }),
  );
}

/** Searches the web via Brave (Serper fallback) and returns normalized results. */
export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web via Brave, falling back to Serper. Use for current events, " +
    "documentation, library versions, or any fact not in the workspace. Requires " +
    "BRAVE_API_KEY or SERPER_API_KEY in the host environment. Returns JSON: " +
    "{provider, query, results: [{title, url, snippet, published}]}.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      count: {
        type: "integer",
        description: "Number of results to return, clamped to [1, 20] (default 10)",
        minimum: 1,
        maximum: 20,
      },
      freshness: {
        type: "string",
        description: "Restrict to results from the last day, week, month, or year (Brave only)",
        enum: [...FRESHNESS],
      },
    },
    required: ["query"],
  },
  execute: (args) => {
    const query = args.query === undefined ? "" : String(args.query);
    const freshness = FRESHNESS.find((window) => window === args.freshness);
    const count = Number.isInteger(args.count) ? (args.count as number) : undefined;

    return webSearch({ query, count, freshness }).pipe(
      Effect.provide(PROVIDED),
      Effect.map((response) => renderResponse(query.trim(), freshness, response)),
      Effect.mapError(
        (error) => new ToolExecutionError({ tool: "web_search", detail: formatError(error) }),
      ),
    );
  },
};
