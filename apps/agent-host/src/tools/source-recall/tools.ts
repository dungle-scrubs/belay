/**
 * Responsible for: the model-facing indexed source-recall tools (plan 38 M2/M7) -
 * `source_recall` (conceptual code search over a prebuilt index), `source_index_status` (index
 * readiness/freshness), and `source_index_refresh` (explicit, user-directed re-index). Each is a thin
 * schema over the provider {@link SourceRecallRegistry}: it decodes bounded args, calls the registry
 * (which selects an adapter and NEVER fails - a missing/unreachable backend becomes a structured
 * `unavailable` result), and serializes the wire envelope the model reads and the web renders. The
 * base schema stays small and provider-neutral (D-003): no provider-specific capability knobs leak in.
 * Query + status are read-only (concurrent-safe reads); refresh mutates external index state, so it is
 * a serial barrier (like `mcp`, D-008). Source recall is retrieval only - it never edits the workspace.
 *
 * Not for: the adapters, HTTP, mapping, config, or selection - those live in sibling modules.
 */
import { Effect, Schema } from "effect";
import { simpleTool } from "../shared";
import type { Tool, ToolContext } from "../types";
import { DEFAULT_TOP_K, MAX_RESULTS, type SourceRecallRegistry } from "./registry";

/** The `source_recall` tool name, shared by the descriptor table + the web renderer. */
export const SOURCE_RECALL_TOOL_NAME = "source_recall" as const;
export const SOURCE_INDEX_STATUS_TOOL_NAME = "source_index_status" as const;
export const SOURCE_INDEX_REFRESH_TOOL_NAME = "source_index_refresh" as const;

const QueryParams = Schema.Struct({
  query: Schema.String.annotations({
    description:
      "The conceptual code question, in natural language (e.g. 'how are sessions verified').",
  }),
  repo: Schema.optional(Schema.String).annotations({
    description: "Restrict the search to this repo name when the provider serves several repos.",
  }),
  provider: Schema.optional(Schema.String).annotations({
    description: "Force a specific configured provider id; omit to use the highest-priority one.",
  }),
  // top_k decodes leniently (any number) and is clamped in the registry to [1, MAX_RESULTS].
  top_k: Schema.optional(
    Schema.Number.annotations({
      jsonSchema: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
    }),
  ).annotations({
    description: `Max results, clamped to [1, ${MAX_RESULTS}] (default ${DEFAULT_TOP_K}).`,
  }),
});

const ScopeParams = Schema.Struct({
  repo: Schema.optional(Schema.String).annotations({
    description: "Restrict to this repo name when the provider serves several repos.",
  }),
  provider: Schema.optional(Schema.String).annotations({
    description: "Force a specific configured provider id; omit to use the highest-priority one.",
  }),
});

/**
 * Builds the three source-recall tools over a provider registry. The registry is injected so the host
 * binds the live (config-driven) one and tests bind a fake-fetch one; the tool NAMES + readOnly nature
 * are config-independent, so the registry parity/table checks hold regardless of what is configured.
 */
export function buildSourceRecallTools(
  registry: SourceRecallRegistry,
): [Tool<typeof QueryParams.Type>, Tool<typeof ScopeParams.Type>, Tool<typeof ScopeParams.Type>] {
  const sourceRecall = simpleTool({
    name: SOURCE_RECALL_TOOL_NAME,
    description:
      "Search THIS project's prebuilt CODE INDEX for a concept and get cited retrieval candidates " +
      "(file, line range, symbol, snippet) with an index-freshness note. Use it for conceptual " +
      "'where/how is X done' questions across the codebase. It is NOT session_recall (that searches " +
      "past conversation memory), NOT grep/ast_grep (exact text/structural match), NOT file-mention " +
      "autocomplete, and NOT an LSP lookup - it returns ranked candidates you then open with read. " +
      "When no indexed provider is configured or reachable it returns a structured 'unavailable' " +
      "result, never an error. Returns JSON: {status, providerId, results:[...], freshness, latencyMs}.",
    params: QueryParams,
    readOnly: true,
    execute: (args, ctx) => {
      const input = {
        query: args.query,
        topK: args.top_k ?? DEFAULT_TOP_K,
        ...(args.repo ? { repo: args.repo } : {}),
        ...(projectRootOf(ctx) ? { projectRoot: projectRootOf(ctx) as string } : {}),
      };
      return Effect.runPromise(registry.query(input, args.provider)).then((r) => JSON.stringify(r));
    },
  });

  const sourceIndexStatus = simpleTool({
    name: SOURCE_INDEX_STATUS_TOOL_NAME,
    description:
      "Report the readiness and freshness of the indexed source-recall provider(s) for this project: " +
      "which repos are served, whether each index is ready or stale, and the discovered capabilities. " +
      "Use it before source_recall when unsure an index exists, or to explain why a search was empty. " +
      "Returns JSON: {status, providerId, capabilities, repos:[{name, readiness, freshness}]}.",
    params: ScopeParams,
    readOnly: true,
    execute: (args) =>
      Effect.runPromise(registry.status(args.repo, args.provider)).then((r) => JSON.stringify(r)),
  });

  const sourceIndexRefresh = simpleTool({
    name: SOURCE_INDEX_REFRESH_TOOL_NAME,
    description:
      "Request an incremental RE-INDEX of the source-recall provider's index for this project (an " +
      "explicit, user-directed action - source recall never auto-indexes a repo). Use it when a " +
      "search looks stale after edits. It is rate-limited by the backend; a too-frequent call returns " +
      "a structured 'rate_limited' result. Returns JSON: {status, providerId, filesUpdated, refreshMs}.",
    params: ScopeParams,
    // Refresh mutates EXTERNAL index state (a side effect on the daemon), so it is a serial barrier.
    execute: (args, ctx) =>
      Effect.runPromise(registry.refresh(args.repo, projectRootOf(ctx), args.provider)).then((r) =>
        JSON.stringify(r),
      ),
  });

  return [sourceRecall, sourceIndexStatus, sourceIndexRefresh];
}

/** The active project root for a provider that maps queries to a project (Aleutian), from the ctx. */
function projectRootOf(ctx: ToolContext | undefined): string | undefined {
  return ctx?.workspaceRoot ?? ctx?.cwd;
}
