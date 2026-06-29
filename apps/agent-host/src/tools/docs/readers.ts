/**
 * The two read-only network seams docs reuses, factored out so discovery (Phase 3) and page fetch
 * (Phase 4) can depend on them without importing back through the tool entry. Both return the raw
 * serialized envelope their owning tool produces (web_fetch / web_search); docs parses the JSON it
 * needs and never reaches past these seams - in particular it never touches a backend (e.g. the
 * rendered backend web_fetch owns) directly.
 */

/**
 * Reads one URL through web_fetch's bounded, attributable JSON envelope. Live deps bind it to
 * `runWebFetch`; tests inject a fake. Absent means the dependency gate reports the tool unavailable.
 */
export type WebFetchReader = (input: {
  readonly url: string;
  readonly mode?: "auto" | "static" | "rendered";
  readonly maxChars?: number;
}) => Promise<string>;

/**
 * Searches the web through web_search's JSON envelope to find candidate documentation roots. Optional
 * - only the subject-query discovery path needs it, so the dependency gate does not require it.
 */
export type WebSearchReader = (input: {
  readonly query: string;
  readonly count?: number;
}) => Promise<string>;
