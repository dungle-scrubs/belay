import type { Effect, Schema } from "effect";
import type { ToolError } from "./errors";

/**
 * The active turn + tool-call correlation a tool MAY use. Passed to `execute` by the executor; nearly
 * every tool ignores it. `ask_user` needs it to tie its pending question to the run/tool-call in the UI.
 */
export interface ToolContext {
  readonly runId?: string;
  readonly callId?: string;
}

/**
 * A tool the model can call: a name, a description, an Effect `Schema` for its
 * parameters, and a typed Effect executor.
 *
 * The schema is the single source of truth for the parameter boundary: the registry
 * DERIVES the advertised JSON Schema from it (`toParametersJsonSchema`) and DECODES the
 * raw arguments against it once in `executeTool`, so `execute` receives a typed, validated
 * `A` - no per-tool `String(args.x ?? "")` coercion or inline `return "error: bad arg"`.
 *
 * The generic `A` is the decoded parameter type. The TOOLS array is heterogeneous, so it
 * holds `Tool<unknown>`; each per-tool definition stays strongly typed via `Tool<T>` where
 * `T = typeof Params.Type`.
 */
export interface Tool<A = unknown> {
  readonly name: string;
  readonly description: string;
  // The Encoded (wire) type is irrelevant at this boundary - only the decoded `A` is - and
  // it genuinely varies per tool (e.g. an optional-with-default field is optional on the
  // wire but present after decode), so it is intentionally erased here.
  // biome-ignore lint/suspicious/noExplicitAny: the schema's Encoded type is erased; only A matters.
  readonly params: Schema.Schema<A, any>;
  /**
   * Whether the tool only reads state and never mutates the workspace. Defaults to false
   * when unset: an unflagged tool is treated as a mutating serial barrier. The agent loop
   * runs a maximal run of `readOnly` calls concurrently, but executes any unflagged tool
   * alone in emission order. Only set this `true` for a tool with no observable side effects.
   */
  readonly readOnly?: boolean;
  execute(args: A, ctx?: ToolContext): Effect.Effect<string, ToolError>;
}
