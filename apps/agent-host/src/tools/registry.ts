import { log, warn } from "@host/transport/log";
import { Effect, Either, JSONSchema, ParseResult, Schema } from "effect";
import type { ToolDef } from "../providers";
import { type ToolError, ToolInputError } from "./errors";
import type { Tool, ToolContext } from "./types";
import { currentLeafWorkspace } from "./workspace";

/**
 * A composable tool registry over an explicit tool collection.
 *
 * Responsible for: deriving provider definitions, filtering offered tools, and decoding/dispatching
 * tool calls through one executable boundary.
 * Not for: constructing the host's default concrete tool list, which remains in index.ts.
 */

export interface ToolRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool params; each concrete tool stays typed.
  readonly tools: readonly Tool<any>[];
  readonly readOnlyTools: ReadonlySet<string>;
  readonly toolDefs: readonly ToolDef[];
  readonly offeredToolDefs: (
    useTools: boolean,
    toolNames: ReadonlySet<string> | undefined,
    delegateDefs: readonly ToolDef[] | undefined,
  ) => readonly ToolDef[];
  readonly executeTool: (
    name: string,
    argumentsJson: string,
    runId?: string,
    callId?: string,
  ) => Effect.Effect<string>;
}

export interface ToolRegistryOptions {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool params; each concrete tool stays typed.
  readonly tools: readonly Tool<any>[];
  readonly readOnlyTools: ReadonlySet<string>;
  readonly now?: () => number;
}

/**
 * Derives the provider-facing JSON Schema for a tool's parameters from its Effect Schema.
 * `JSONSchema.make` returns a draft-07 doc with top-level metadata that providers do not need.
 */
export function toParametersJsonSchema(
  schema: Schema.Schema<unknown, unknown>,
): Record<string, unknown> {
  const { $schema, $id, $defs, ...rest } = JSONSchema.make(schema) as unknown as Record<
    string,
    unknown
  >;
  if ($defs) {
    throw new Error(
      `tool parameter schema produced a $defs block (must stay flat): ${JSON.stringify($defs)}`,
    );
  }
  return rest;
}

export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  const now = options.now ?? Date.now;
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const toolDefs = options.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toParametersJsonSchema(tool.params),
  }));

  function offeredToolDefs(
    useTools: boolean,
    toolNames: ReadonlySet<string> | undefined,
    delegateDefs: readonly ToolDef[] | undefined,
  ): readonly ToolDef[] {
    const registryTools = useTools ? toolDefs : [];
    const allowed = toolNames
      ? registryTools.filter((tool) => toolNames.has(tool.name))
      : registryTools;
    return delegateDefs ? [...allowed, ...delegateDefs] : allowed;
  }

  function executeTool(
    name: string,
    argumentsJson: string,
    runId?: string,
    callId?: string,
  ): Effect.Effect<string> {
    const tool = toolsByName.get(name);
    if (!tool) {
      return Effect.succeed(`error: unknown tool "${name}"`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(argumentsJson || "{}");
    } catch {
      return Effect.succeed("error: tool arguments were not valid JSON");
    }
    const decoded = Schema.decodeUnknownEither(tool.params)(parsed);
    if (Either.isLeft(decoded)) {
      const detail = ParseResult.TreeFormatter.formatErrorSync(decoded.left);
      return renderFailure(name, new ToolInputError({ tool: name, detail }), runId, now());
    }
    const startedAt = now();
    return currentLeafWorkspace.pipe(
      Effect.flatMap((workspace) => {
        const ctx: ToolContext = {
          runId,
          callId,
          ...(workspace ? { cwd: workspace.cwd, workspaceRoot: workspace.root } : {}),
        };
        return tool.execute(decoded.right, ctx).pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              log("tool", "executed", { run: runId, name, ms: now() - startedAt, ok: true }),
            ),
          ),
          Effect.catchAll((error) => renderFailure(name, error, runId, startedAt)),
        );
      }),
    );
  }

  function renderFailure(
    name: string,
    error: ToolError,
    runId: string | undefined,
    startedAt: number,
  ): Effect.Effect<string> {
    return Effect.sync(() => {
      warn("tool", "failed", {
        run: runId,
        name,
        kind: error._tag,
        ms: now() - startedAt,
        error: error.message,
      });
      return `error: ${name} failed - ${error.message}`;
    });
  }

  return {
    tools: options.tools,
    readOnlyTools: options.readOnlyTools,
    toolDefs,
    offeredToolDefs,
    executeTool,
  };
}
