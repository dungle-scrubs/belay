import type { Effect } from "effect";
import type { ToolError } from "./errors";

/** A tool the model can call: a name + JSON-Schema parameters, and an Effect executor. */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Effect.Effect<string, ToolError>;
}
