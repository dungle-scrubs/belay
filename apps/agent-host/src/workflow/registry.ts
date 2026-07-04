/**
 * The in-memory workflow registry and the name+args resolution entry. Two authoring paths coexist:
 * developer-authored built-in modules (invoked by name+args - the fleet, 46, is the first) and
 * model-authored saved specs (data the interpreter walks). Resolution validates args against a
 * definition's declared schema before the engine ever runs it.
 *
 * Responsible for: registering workflow definitions, lookup by name, and resolve(name, args) with
 * typed not-found / bad-args failures.
 * Not for: the spec schema and determinism check (spec.ts), or executing a resolved workflow (the
 * engine interpreter, M3).
 */
import { Either, ParseResult, Schema } from "effect";
import { WorkflowArgsInvalid, WorkflowNotFound } from "./errors";
import type { WorkflowSpec } from "./spec";

/**
 * A developer-authored, trusted, in-process workflow module invoked by name+args. Its interpreter
 * body is attached by the engine in a later milestone; M1 owns the contract + optional args schema.
 */
export interface BuiltinWorkflow {
  readonly source: "builtin";
  readonly name: string;
  readonly description: string;
  readonly args?: Schema.Schema.AnyNoContext;
}

/** A model-authored, saved `WorkflowSpec` (data) the engine interpreter walks. */
export interface SpecWorkflow {
  readonly source: "spec";
  readonly name: string;
  readonly description: string;
  readonly spec: WorkflowSpec;
  readonly args?: Schema.Schema.AnyNoContext;
}

export type WorkflowDefinition = BuiltinWorkflow | SpecWorkflow;

/** A definition resolved against a name with its args validated - the hand-off the engine runs. */
export interface ResolvedWorkflow {
  readonly definition: WorkflowDefinition;
  readonly args: unknown;
}

export interface WorkflowRegistry {
  readonly list: () => readonly WorkflowDefinition[];
  readonly get: (name: string) => WorkflowDefinition | undefined;
  readonly resolve: (
    name: string,
    args: unknown,
  ) => Either.Either<ResolvedWorkflow, WorkflowNotFound | WorkflowArgsInvalid>;
}

/**
 * Build a registry over a fixed set of definitions. Lookup is by name (last-wins on duplicates,
 * matching the host's other name→def registries).
 */
export function createWorkflowRegistry(
  definitions: readonly WorkflowDefinition[],
): WorkflowRegistry {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));

  const resolve = (
    name: string,
    args: unknown,
  ): Either.Either<ResolvedWorkflow, WorkflowNotFound | WorkflowArgsInvalid> => {
    const definition = byName.get(name);
    if (definition === undefined) {
      return Either.left(new WorkflowNotFound({ name }));
    }
    if (definition.args !== undefined) {
      const decoded = Schema.decodeUnknownEither(definition.args)(args);
      if (Either.isLeft(decoded)) {
        return Either.left(
          new WorkflowArgsInvalid({
            name,
            detail: ParseResult.TreeFormatter.formatErrorSync(decoded.left),
          }),
        );
      }
      return Either.right({ definition, args: decoded.right });
    }
    return Either.right({ definition, args });
  };

  return {
    list: () => definitions,
    get: (name) => byName.get(name),
    resolve,
  };
}
