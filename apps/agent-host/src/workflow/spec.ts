/**
 * The WorkflowSpec: the validated, data-only DSL a model authors through the `Workflow` tool, which
 * the engine interpreter walks. It is DATA, never code - so determinism is checked STATICALLY here
 * (no clock/RNG references, a literal header). That check is the necessary-but-not-sufficient half
 * of sound resume, paired with the ordinal journal + Usage replay added in M4 (21/D-015).
 *
 * Responsible for: the `WorkflowSpec` Effect `Schema`, its static determinism scan, and the decode
 * entry that yields a validated spec or a typed `WorkflowSpecInvalid`.
 * Not for: executing a spec (the engine interpreter, M3), or the built-in/saved registry
 * (registry.ts).
 */
import { Either, ParseResult, Schema } from "effect";
import { WorkflowSpecInvalid } from "./errors";

/**
 * A stable model reference: source + model id + selected reasoning. Structurally mirrors
 * `@trevor/session` `model-source` `ModelRef`, so `opts.model` resolves through
 * `providerForSource`/`buildSourceProvider` when the leaf runs (M2, 21/D-014).
 */
export const ModelRef = Schema.Struct({
  sourceId: Schema.String,
  modelId: Schema.String,
  reasoning: Schema.NullOr(Schema.String),
});
export type ModelRef = typeof ModelRef.Type;

/** One leaf in a phase: an `agent()` call the interpreter will spawn. `deps` names sibling ids it
 *  waits on (a DAG within a phase). */
export const AgentSpec = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  schema: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  model: Schema.optional(ModelRef),
  isolation: Schema.optional(Schema.Literal("worktree")),
  deps: Schema.optional(Schema.Array(Schema.String)),
});
export type AgentSpec = typeof AgentSpec.Type;

/** How a phase's agents run: one after another, all at once (barrier), or per-item staged flow. */
export const PhaseMode = Schema.Literal("sequential", "parallel", "pipeline");
export type PhaseMode = typeof PhaseMode.Type;

export const WorkflowPhase = Schema.Struct({
  title: Schema.String,
  mode: PhaseMode,
  agents: Schema.Array(AgentSpec),
});
export type WorkflowPhase = typeof WorkflowPhase.Type;

/** The literal header: name + description, required and non-computed (data, not an expression). */
export const WorkflowMeta = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
});
export type WorkflowMeta = typeof WorkflowMeta.Type;

export const WorkflowSpec = Schema.Struct({
  meta: WorkflowMeta,
  phases: Schema.Array(WorkflowPhase),
});
export type WorkflowSpec = typeof WorkflowSpec.Type;

/** Nondeterminism tokens forbidden anywhere in a spec's string leaves: a spec that interpolates a
 *  clock/RNG would replay differently, breaking resume. */
const FORBIDDEN: readonly { readonly token: RegExp; readonly label: string }[] = [
  { token: /\bDate\s*\.\s*now\b/, label: "Date.now" },
  { token: /\bMath\s*\.\s*random\b/, label: "Math.random" },
  { token: /\bnew\s+Date\b/, label: "new Date" },
  { token: /\bperformance\s*\.\s*now\b/, label: "performance.now" },
];

/**
 * Walk every string leaf of a decoded spec, returning `"path: token"` for each nondeterminism
 * reference found (empty when clean). Total and side-effect-free - the spec is data.
 */
export function findNondeterminism(spec: WorkflowSpec): readonly string[] {
  const hits: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      for (const { token, label } of FORBIDDEN) {
        if (token.test(value)) {
          hits.push(`${path || "<root>"}: ${label}`);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, `${path}[${index}]`);
      });
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        walk(child, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(spec, "");
  return hits;
}

/**
 * Decode untrusted input into a validated, deterministic `WorkflowSpec`, or a typed
 * `WorkflowSpecInvalid`. Two gates: the schema (shape) and the static determinism scan (no
 * clock/RNG in any string leaf, including the header).
 */
export function decodeWorkflowSpec(
  input: unknown,
): Either.Either<WorkflowSpec, WorkflowSpecInvalid> {
  const decoded = Schema.decodeUnknownEither(WorkflowSpec)(input);
  if (Either.isLeft(decoded)) {
    return Either.left(
      new WorkflowSpecInvalid({ detail: ParseResult.TreeFormatter.formatErrorSync(decoded.left) }),
    );
  }
  const nondeterminism = findNondeterminism(decoded.right);
  if (nondeterminism.length > 0) {
    return Either.left(
      new WorkflowSpecInvalid({
        detail: `nondeterministic references (a spec is data - no clocks/RNG): ${nondeterminism.join(", ")}`,
      }),
    );
  }
  return Either.right(decoded.right);
}
