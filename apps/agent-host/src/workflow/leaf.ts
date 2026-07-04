/**
 * The `agent()` leaf's control logic: a forked, interruptible entry over the delegated-child turn
 * that runs IN the orchestration fiber (so fiber interruption halts it), drives the child across one
 * or more turns to a semantic completion, validates a schema-forced result, and maps every outcome
 * onto ONE typed result channel - a success value or a typed `LeafFailure` (child-turn-failed /
 * schema-invalid / budget-exhausted / cancelled / model-unresolvable / local-not-ready) carrying a
 * structured cause + the child session id (21/D-011, D-012, D-017, D-022). The concurrency primitives
 * observe this typed result, never a thrown exception.
 *
 * The turn mechanics (publishTurn in-fiber, durable-log reprojection, provider resolution) are
 * injected as `LeafDeps` so this control logic is unit-testable without the whole turn/transport
 * stack; leaf-host.ts wires the real host collaborators.
 *
 * Responsible for: the leaf's typed result taxonomy + the multi-turn / schema-retry / per-leaf token
 * budget control loop over injected turn deps.
 * Not for: the real publishTurn/transport/catalog wiring (leaf-host.ts), or fan-out over leaves
 * (the concurrency primitives, M3).
 */
import { Effect, Either, ParseResult, Schema } from "effect";

/** One child turn's usage: prompt size (`input`) and generated tokens (`output`). */
export interface TurnUsage {
  readonly input: number;
  readonly output: number;
}

/**
 * Why one child turn ended, the signal the multi-turn loop reads:
 * - `answered`: the model produced a final reply without hitting a budget backstop -> semantic done.
 * - `cutoff`: the turn hit its per-turn step/context backstop (a forced synthesis) -> a whole-plan
 *   task needs another turn (D-017).
 * - `error`: the child turn failed (a provider/host failure surfaced on the completion).
 * - `cancelled`: the child turn was interrupted.
 */
export type TurnEndReason = "answered" | "cutoff" | "error" | "cancelled";

export interface TurnOutcome {
  readonly text: string;
  readonly usage: TurnUsage;
  readonly endReason: TurnEndReason;
  /** Present when `endReason === "error"`: the child's structured failure cause. */
  readonly cause?: string;
}

/** The typed failure taxonomy the leaf surfaces (never thrown). */
export type LeafFailureKind =
  | "child-turn-failed"
  | "schema-invalid"
  | "budget-exhausted"
  | "cancelled"
  | "model-unresolvable"
  | "local-not-ready";

export interface LeafFailure {
  readonly ok: false;
  readonly kind: LeafFailureKind;
  readonly childSessionId: string;
  /** Structured cause: the failure taxonomy detail, diagnosable without opening the child transcript. */
  readonly cause: string;
  /** Optional opaque caller-supplied detail (e.g. a worker's partial progress), journaled with the
   *  leaf-failed event so a fail-soft-null leaf stays diagnosable (D-022). */
  readonly detail?: unknown;
}

export interface LeafSuccess<A = unknown> {
  readonly ok: true;
  readonly childSessionId: string;
  readonly text: string;
  /** The schema-validated object when the request set a schema; absent otherwise. */
  readonly value?: A;
  /** Aggregate usage across the leaf's turns: last-turn input, summed output. */
  readonly usage: TurnUsage;
}

export type LeafResult<A = unknown> = LeafSuccess<A> | LeafFailure;

/** What one `agent()` call requests. Budgets and turn count are per-leaf opts (D-020, D-017). */
export interface LeafRequest {
  readonly childSessionId: string;
  /** Optional output schema: when set, the final text is parsed + decoded, with one repair attempt. */
  readonly schema?: Schema.Schema.AnyNoContext;
  /** Aggregate generated-token cap over all the leaf's turns; undefined = unbounded (D-020). */
  readonly tokenBudget?: number;
  /** Maximum turns the leaf may run. 1 (default) = a single-turn leaf; >1 = a multi-turn worker
   *  leaf that continues a cut-off child to a semantic completion (D-017). */
  readonly maxTurns?: number;
}

/**
 * The injected turn mechanics. `runTurn(index)` runs one child turn IN the caller's fiber: index 0
 * seeds + runs the first turn; index > 0 continues over the reprojected durable log with a
 * continuation message. `repair` runs one extra turn asking the child to fix a schema-invalid reply.
 */
export interface LeafDeps {
  readonly runTurn: (index: number) => Effect.Effect<TurnOutcome>;
  readonly repair?: (detail: string) => Effect.Effect<TurnOutcome>;
}

function fail(
  childSessionId: string,
  kind: LeafFailureKind,
  cause: string,
  detail?: unknown,
): LeafFailure {
  return detail === undefined
    ? { ok: false, kind, childSessionId, cause }
    : { ok: false, kind, childSessionId, cause, detail };
}

/** Parse `text` as JSON and decode it against `schema`; Right = value, Left = a human cause string. */
function validateAgainst(
  schema: Schema.Schema.AnyNoContext,
  text: string,
): Either.Either<unknown, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return Either.left("the leaf's output was not valid JSON");
  }
  const decoded = Schema.decodeUnknownEither(schema)(parsed);
  return Either.isLeft(decoded)
    ? Either.left(ParseResult.TreeFormatter.formatErrorSync(decoded.left))
    : Either.right(decoded.right);
}

/** Map a turn that ended in `error`/`cancelled` to a typed leaf failure; null when the turn is usable
 *  (answered or cut off). `label` names the turn (`"child turn"` / `"schema-repair turn"`). */
function terminalFailure(
  outcome: TurnOutcome,
  childSessionId: string,
  label: string,
): LeafFailure | null {
  if (outcome.endReason === "error") {
    return fail(
      childSessionId,
      "child-turn-failed",
      outcome.cause ?? `the ${label} failed`,
      outcome.text || undefined,
    );
  }
  if (outcome.endReason === "cancelled") {
    return fail(childSessionId, "cancelled", `the ${label} was cancelled`);
  }
  return null;
}

/**
 * Run the leaf to a typed result. The loop runs up to `maxTurns` child turns, continuing only a
 * cut-off turn while budget remains, and stops on the first `answered` turn (semantic completion),
 * an `error`/`cancelled` turn (typed failure), or the per-leaf token cap (budget-exhausted, carrying
 * the partial text as `detail`). A schema request validates the final text with one repair attempt.
 * This is one call ordinal regardless of how many turns it takes (D-017).
 */
export function runLeaf<A = unknown>(
  request: LeafRequest,
  deps: LeafDeps,
): Effect.Effect<LeafResult<A>> {
  const { childSessionId } = request;
  const maxTurns = Math.max(1, request.maxTurns ?? 1);

  return Effect.gen(function* () {
    let lastText = "";
    let spentOutput = 0;
    let inputTokens = 0;

    for (let index = 0; index < maxTurns; index++) {
      const outcome = yield* deps.runTurn(index);
      spentOutput += outcome.usage.output;
      inputTokens = outcome.usage.input;
      lastText = outcome.text;

      const turnFailure = terminalFailure(outcome, childSessionId, "child turn");
      if (turnFailure !== null) {
        return turnFailure;
      }
      if (outcome.endReason === "answered") {
        break;
      }
      // A cut-off turn. Stop if this was the last allowed turn (finalize best-effort), or if the
      // per-leaf token cap is spent mid-task (a typed budget failure carrying the partial text).
      const lastAllowed = index + 1 >= maxTurns;
      if (lastAllowed) {
        break;
      }
      if (request.tokenBudget !== undefined && spentOutput >= request.tokenBudget) {
        return fail(
          childSessionId,
          "budget-exhausted",
          `per-leaf token cap reached (${spentOutput}/${request.tokenBudget}) before the task completed`,
          lastText || undefined,
        );
      }
    }

    if (request.schema !== undefined) {
      let validated = validateAgainst(request.schema, lastText);
      if (Either.isLeft(validated) && deps.repair !== undefined) {
        const repairOutcome = yield* deps.repair(validated.left);
        const repairFailure = terminalFailure(repairOutcome, childSessionId, "schema-repair turn");
        if (repairFailure !== null) {
          return repairFailure;
        }
        spentOutput += repairOutcome.usage.output;
        inputTokens = repairOutcome.usage.input;
        lastText = repairOutcome.text;
        validated = validateAgainst(request.schema, lastText);
      }
      if (Either.isLeft(validated)) {
        return fail(childSessionId, "schema-invalid", validated.left, lastText || undefined);
      }
      return {
        ok: true,
        childSessionId,
        text: lastText,
        value: validated.right as A,
        usage: { input: inputTokens, output: spentOutput },
      };
    }

    return {
      ok: true,
      childSessionId,
      text: lastText,
      usage: { input: inputTokens, output: spentOutput },
    };
  });
}
