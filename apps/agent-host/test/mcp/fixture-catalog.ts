/**
 * The shared capability catalog both MCP fixture servers serve (plan 23 M4), so the stdio and
 * http fixtures list identical tools/resources/prompts and the discovery tests are
 * transport-agnostic. Three catalog modes:
 *   default  - the two M2 tools (echo, env_probe)
 *   large    - LARGE_CATALOG_SIZE generated tools (paginated at CATALOG_PAGE_SIZE per
 *              tools/list page) for the D-003 search-cap tests, including four crafted
 *              "anchor" tools that pin the search RANKING assertions
 *   counting - a refresh_probe tool whose description carries the tools/list call number,
 *              so a re-discovery is observably a re-read
 */

export type FixtureCatalogMode = "default" | "large" | "counting";

export interface CatalogTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

const EMPTY_OBJECT_SCHEMA = { type: "object", properties: {} } as const;

export const DEFAULT_CATALOG_TOOLS: readonly CatalogTool[] = [
  {
    name: "echo",
    description: "echoes text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  {
    name: "env_probe",
    description: "returns this process's environment",
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
];

export const LARGE_CATALOG_SIZE = 500;
export const CATALOG_PAGE_SIZE = 200;

/** Four crafted tools whose names/descriptions pin the search-ranking assertions:
 *  exact name > name prefix > name substring > description-only match, for query "anchor". */
export const RANKED_CATALOG_TOOLS: readonly CatalogTool[] = [
  { name: "anchor", description: "the exact-name match target", inputSchema: EMPTY_OBJECT_SCHEMA },
  {
    name: "anchor_extra",
    description: "the name-prefix match target",
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    name: "grand_anchor_tool",
    description: "the name-substring match target",
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    name: "plainly_named",
    description: "matches anchor only here in the description",
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
];

/** The full large catalog: the ranked tools plus generated bulk up to LARGE_CATALOG_SIZE. */
export function largeCatalogTools(): readonly CatalogTool[] {
  const bulk = Array.from(
    { length: LARGE_CATALOG_SIZE - RANKED_CATALOG_TOOLS.length },
    (_, index): CatalogTool => ({
      name: `bulk_tool_${String(index).padStart(3, "0")}`,
      description: `generated bulk tool ${index} for catalog-cap tests`,
      inputSchema: { type: "object", properties: { input: { type: "string" } } },
    }),
  );
  return [...RANKED_CATALOG_TOOLS, ...bulk];
}

/** The tools a fixture serves for `mode`; `listCalls` is that fixture's tools/list counter. */
export function catalogToolsFor(
  mode: FixtureCatalogMode,
  listCalls: number,
): readonly CatalogTool[] {
  if (mode === "large") {
    return largeCatalogTools();
  }
  if (mode === "counting") {
    return [
      {
        name: "refresh_probe",
        description: `tools/list call #${listCalls}`,
        inputSchema: EMPTY_OBJECT_SCHEMA,
      },
      ...DEFAULT_CATALOG_TOOLS,
    ];
  }
  return DEFAULT_CATALOG_TOOLS;
}

/** One MCP list page: CATALOG_PAGE_SIZE items from `cursor` (a stringified offset). */
export function catalogPage<T>(
  items: readonly T[],
  cursor: string | undefined,
): { readonly page: readonly T[]; readonly nextCursor?: string } {
  const start = cursor ? Number(cursor) : 0;
  const next = start + CATALOG_PAGE_SIZE;
  return {
    page: items.slice(start, next),
    ...(next < items.length ? { nextCursor: String(next) } : {}),
  };
}

export const FIXTURE_RESOURCES = [
  {
    uri: "fixture://readme",
    name: "readme",
    description: "the fixture readme",
    mimeType: "text/plain",
  },
  {
    uri: "fixture://logs/today",
    name: "daily_log",
    description: "today's fixture log",
    mimeType: "text/plain",
  },
] as const;

export const FIXTURE_PROMPTS = [
  {
    name: "summarize",
    description: "summarize the given text",
    arguments: [{ name: "text", description: "the text to summarize", required: true }],
  },
  { name: "greet", description: "produce a fixture greeting" },
] as const;

/** Default size for the `big` behavior tool + the oversized fixture resource (M5): larger than
 *  the host's MAX_OUTPUT (8000), so bounding is observable. */
export const BIG_FIXTURE_CHARS = 20_000;

export interface FixtureResourceContents {
  readonly mimeType: string;
  readonly text?: string;
  readonly blob?: string;
}

/** What `resources/read` serves, keyed by uri (M5). `fixture://big` and `fixture://blob` are
 *  readable but deliberately unlisted (like the boom/hang behavior tools), so the M4 discovery
 *  assertions over FIXTURE_RESOURCES stay untouched. */
export const FIXTURE_RESOURCE_CONTENTS: Readonly<Record<string, FixtureResourceContents>> = {
  "fixture://readme": {
    mimeType: "text/plain",
    text: "fixture readme body: hello from the fixture catalog\n",
  },
  "fixture://logs/today": { mimeType: "text/plain", text: "log line 1\nlog line 2\n" },
  "fixture://big": { mimeType: "text/plain", text: "r".repeat(BIG_FIXTURE_CHARS) },
  "fixture://blob": {
    mimeType: "application/octet-stream",
    blob: Buffer.from("binary fixture bytes").toString("base64"),
  },
};
