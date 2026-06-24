/**
 * The canonical token-breakdown category schema - the single source of truth for
 * "where does the context go?" Host accumulation/totals/logs, the wire `UsageBreakdown`
 * type, its decoder, and the web treemap/legend all derive from this one descriptor, so
 * adding or renaming a category is one edit and the three surfaces cannot drift.
 *
 * The two pools are kept separate (see the host accumulator's header): `input` is what
 * fills the prompt and persists across steps; `output` is what the model generates this
 * turn and is not retained. `toolCallArgs` lives in BOTH pools (generated AND fed back),
 * so it appears twice - once per pool. `isOverhead` marks the fixed-overhead input
 * categories (everything except tool results) that the web rolls into one "overhead"
 * cell; it is meaningless for output categories.
 *
 * Images (`imagesBase64`/`imageCount`) and the per-tool split (`byTool`) are NOT
 * categories here: image cost is not proportional to base64 length and byTool is a
 * sub-breakdown, so both stay as explicit fields on the input pool (see UsageBreakdown).
 */

export type BreakdownPool = "input" | "output";

export interface BreakdownCategory {
  /** The field name this category occupies on `UsageBreakdown[pool]`. */
  readonly key: string;
  readonly pool: BreakdownPool;
  /** A neutral human label for legends (the web capitalizes as needed). */
  readonly label: string;
  /** Input fixed-overhead (system prompt, tool schemas, prior text, tool-call args) that
   *  rolls up into the web "overhead" cell. False for tool results and all output. */
  readonly isOverhead: boolean;
}

export const BREAKDOWN_CATEGORIES = [
  { key: "systemAndTools", pool: "input", label: "system + tools", isOverhead: true },
  { key: "userText", pool: "input", label: "user text", isOverhead: true },
  { key: "assistantText", pool: "input", label: "assistant text", isOverhead: true },
  { key: "toolCallArgs", pool: "input", label: "tool-call args", isOverhead: true },
  { key: "toolResults", pool: "input", label: "tool results", isOverhead: false },
  { key: "thinking", pool: "output", label: "thinking", isOverhead: false },
  { key: "answer", pool: "output", label: "answer", isOverhead: false },
  { key: "toolCallArgs", pool: "output", label: "tool-call args", isOverhead: false },
] as const satisfies readonly BreakdownCategory[];

type Category = (typeof BREAKDOWN_CATEGORIES)[number];
type KeysIn<P extends BreakdownPool> = Extract<Category, { pool: P }>["key"];
/** The character-count fields for one pool, derived from the descriptor. */
type PoolCounts<P extends BreakdownPool> = { readonly [K in KeysIn<P>]: number };

/**
 * Per-turn token-source breakdown carried on the wire (character counts). The text
 * categories are derived from BREAKDOWN_CATEGORIES; images and the per-tool split are
 * explicit because they are not proportional text categories.
 */
export interface UsageBreakdown {
  readonly input: PoolCounts<"input"> & {
    readonly imagesBase64: number;
    readonly imageCount: number;
    /** Tool-result chars keyed by tool name - which tool is eating the context. */
    readonly byTool: Readonly<Record<string, number>>;
  };
  readonly output: PoolCounts<"output">;
}
