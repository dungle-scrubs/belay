import { RECALL_KINDS, type RecallKind } from "@trevor/session";
import { Schema } from "effect";
import { recallEngine } from "../agent/recall/engine";
import type { RecallFilters } from "../agent/recall/types";
import { simpleTool } from "./shared";

/**
 * The `session_recall` model-facing tool (D-044 M4). It searches the current PROJECT's durable
 * conversation memory that is NOT already in the active prompt - the compacted-away detail of this
 * session plus other sessions for the same project - and returns distilled findings with
 * citations. It never loads or switches sessions, runs no slash command, and does not search the
 * codebase; for files/code the model uses read/grep/glob instead.
 *
 * The result is a JSON envelope (like web_search): the model reads the findings + sources; the web
 * parses the same payload into the recall transcript surface. Recall is read-only - it only reads
 * durable logs - so the loop may run it concurrently with other reads.
 */

const Params = Schema.Struct({
  query: Schema.String.annotations({
    description: "What older project/session memory to recall, in natural language.",
  }),
  session_ids: Schema.optional(Schema.Array(Schema.String)).annotations({
    description: "Restrict the search to these durable session ids (after project scoping).",
  }),
  from_seq: Schema.optional(Schema.Number).annotations({
    description: "Only recall records anchored at or after this event seq.",
  }),
  to_seq: Schema.optional(Schema.Number).annotations({
    description: "Only recall records anchored at or before this event seq.",
  }),
  kinds: Schema.optional(Schema.Array(Schema.String)).annotations({
    description: `Restrict to record kinds: ${RECALL_KINDS.join(", ")}.`,
  }),
  tool: Schema.optional(Schema.String).annotations({
    description: "Restrict tool records to this tool name (e.g. grep, read).",
  }),
  fold_id: Schema.optional(Schema.String).annotations({
    description: "Restrict to records inside this compaction fold.",
  }),
  max_results: Schema.optional(Schema.Number).annotations({
    description: "Cap the number of source anchors returned (default 8).",
  }),
});

type RecallArgs = Schema.Schema.Type<typeof Params>;

/** Builds the engine filters from the flat tool args (kept flat so the params schema has no $defs). */
function filtersOf(args: RecallArgs): RecallFilters {
  const kinds = args.kinds?.filter((kind): kind is RecallKind =>
    (RECALL_KINDS as readonly string[]).includes(kind),
  );
  const turnRange =
    args.from_seq != null || args.to_seq != null
      ? { fromSeq: args.from_seq, toSeq: args.to_seq }
      : undefined;
  return {
    sessionIds: args.session_ids,
    kinds: kinds && kinds.length > 0 ? kinds : undefined,
    tool: args.tool,
    foldId: args.fold_id,
    turnRange,
  };
}

export const sessionRecallTool = simpleTool({
  name: "session_recall",
  description:
    "Recall older conversation memory for THIS project that is no longer in the active prompt - " +
    "compacted-away detail from this session and other sessions for the same project. Use it only " +
    "when the user asks about earlier decisions, prior discussions, or what happened before that " +
    "you cannot see in the current context. It does not switch sessions and does not search code " +
    "(use read/grep/glob for files). Returns distilled findings with citations to the sessions and " +
    "turns they came from.",
  params: Params,
  readOnly: true,
  execute: async (args) => {
    const result = await recallEngine.recall({
      query: args.query,
      filters: filtersOf(args),
      searchCaps: args.max_results != null ? { maxAnchors: args.max_results } : undefined,
    });
    return JSON.stringify(result);
  },
});
