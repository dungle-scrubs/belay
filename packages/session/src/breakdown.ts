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

/** A zero `UsageBreakdown` - the additive identity for `addBreakdown` and the empty
 *  accumulator a category-driven sum folds onto (also the seed the wire decoder overlays). */
export function emptyBreakdown(): UsageBreakdown {
  const input = { imagesBase64: 0, imageCount: 0, byTool: {} as Record<string, number> } as Record<
    string,
    unknown
  >;
  const output = {} as Record<string, number>;
  for (const c of BREAKDOWN_CATEGORIES) {
    if (c.pool === "input") {
      input[c.key] = 0;
    } else {
      output[c.key] = 0;
    }
  }
  return { input, output } as unknown as UsageBreakdown;
}

/**
 * Sums two `UsageBreakdown`s category by category, driven by `BREAKDOWN_CATEGORIES`
 * plus the explicit image/byTool fields - so the fold can never drift from the
 * canonical category set (adding a category here is zero extra edits). Used to
 * accumulate every completed request's breakdown into the whole-context total.
 */
export function addBreakdown(a: UsageBreakdown, b: UsageBreakdown): UsageBreakdown {
  const out = emptyBreakdown();
  const oi = out.input as unknown as Record<string, number>;
  const oo = out.output as unknown as Record<string, number>;
  const ai = a.input as unknown as Record<string, number>;
  const ao = a.output as unknown as Record<string, number>;
  const bi = b.input as unknown as Record<string, number>;
  const bo = b.output as unknown as Record<string, number>;
  for (const c of BREAKDOWN_CATEGORIES) {
    if (c.pool === "input") {
      oi[c.key] = (ai[c.key] ?? 0) + (bi[c.key] ?? 0);
    } else {
      oo[c.key] = (ao[c.key] ?? 0) + (bo[c.key] ?? 0);
    }
  }
  oi.imagesBase64 = a.input.imagesBase64 + b.input.imagesBase64;
  oi.imageCount = a.input.imageCount + b.input.imageCount;
  const byTool = out.input.byTool as Record<string, number>;
  for (const [name, chars] of Object.entries(a.input.byTool)) {
    byTool[name] = (byTool[name] ?? 0) + chars;
  }
  for (const [name, chars] of Object.entries(b.input.byTool)) {
    byTool[name] = (byTool[name] ?? 0) + chars;
  }
  return out;
}

/**
 * The canonical DISPLAY rollup of "where did this call's tokens go": the user-facing grouping of the
 * raw categories into a handful of cells, each with a stable label + semantic color. This is the
 * single source the web treemap/legend renders, so the grouping and colors live here, not hardcoded
 * per surface. The color is a CSS custom-property NAME (no `hsl(var(...))` wrapper, no CSS imported
 * here) - the web resolves it; this package stays presentation-free beyond naming the token.
 *
 *   - `tools`    = input tool RESULTS (the non-overhead input categories),
 *   - `overhead` = the fixed input overhead (system+tools, user/assistant text, tool-call args),
 *   - `thinking` / `answer` = the two output categories the user cares about (output tool-call args
 *     are not surfaced - they ride the assistant turn, not the answer).
 */
export interface BreakdownGroup {
  readonly key: string;
  readonly label: string;
  /** CSS custom-property name, e.g. `smui-frost-3`; the web renders `hsl(var(--<color>))`. */
  readonly color: string;
}

export const BREAKDOWN_GROUPS = [
  { key: "tools", label: "tool results", color: "smui-frost-3" },
  { key: "thinking", label: "thinking", color: "smui-yellow" },
  { key: "answer", label: "final response", color: "smui-green" },
  { key: "overhead", label: "overhead", color: "muted-foreground" },
] as const satisfies readonly BreakdownGroup[];

/** A display group plus its char count for one breakdown. */
export interface BreakdownRow extends BreakdownGroup {
  readonly value: number;
}

/** Sums one input pool over the overhead / non-overhead split, driven by the descriptor so it can
 *  never drift from the category set (byTool/images are not categories, so they are never read). */
function sumInput(b: UsageBreakdown, overhead: boolean): number {
  const counts = b.input as unknown as Record<string, number>;
  return BREAKDOWN_CATEGORIES.reduce(
    (total, c) =>
      c.pool === "input" && c.isOverhead === overhead ? total + (counts[c.key] ?? 0) : total,
    0,
  );
}

/**
 * Rolls a `UsageBreakdown` into the canonical display rows (one value per `BREAKDOWN_GROUPS` cell), in
 * descriptor order. Zero-value rows are KEPT - the caller decides whether to drop them (the web does,
 * since the treemap floors tiny cells rather than dropping them). The single rollup both the web
 * treemap and any other "where did the tokens go" view derive from.
 */
export function rollupBreakdown(b: UsageBreakdown): BreakdownRow[] {
  const valueByKey: Record<string, number> = {
    tools: sumInput(b, false),
    overhead: sumInput(b, true),
    thinking: b.output.thinking,
    answer: b.output.answer,
  };
  return BREAKDOWN_GROUPS.map((group) => ({ ...group, value: valueByKey[group.key] ?? 0 }));
}

/**
 * The single char -> token heuristic shared by host estimates and web display. Real token counts
 * come from reported provider usage; this deliberately rough ~4 chars/token proxy is used only
 * where no measurement exists: usage-breakdown display, compaction summaries, recall budgets, and
 * the reclaimed-token label. Lives here beside the category schema so host and web cannot drift.
 */
export const CHARS_PER_TOKEN = 4;

/** Estimates tokens from a character count via the shared ~4 chars/token heuristic. */
export const estimateTokens = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN);

/**
 * Total input-pool chars across the descriptor categories. Images (`imagesBase64`) and `byTool`
 * are NOT categories and are excluded: a vision model's token cost is not proportional to base64
 * length, so folding image bytes into the text estimate would badly distort it. This is exactly
 * the rule the host accumulator's `poolTotal("input")` applies, so the one chars total has one home.
 */
export function inputBreakdownChars(breakdown: UsageBreakdown): number {
  const counts = breakdown.input as unknown as Record<string, number>;
  return BREAKDOWN_CATEGORIES.reduce(
    (total, c) => (c.pool === "input" ? total + (counts[c.key] ?? 0) : total),
    0,
  );
}

/**
 * Estimated input tokens for a wire breakdown - the input-pool char total (images excluded) run
 * through the shared heuristic. The one answer to "how many input tokens did this turn use" for
 * both host display and the web transcript meta line.
 */
export function inputEstimateTokens(breakdown: UsageBreakdown): number {
  return estimateTokens(inputBreakdownChars(breakdown));
}
