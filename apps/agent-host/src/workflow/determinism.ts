/**
 * The determinism-characterization harness for built-in (trusted, in-process) workflows (plan 21 M8,
 * D-021 - the audit's seam-10 fix). Built-ins are not statically clock-banned (unlike the DSL) and
 * not capability-neutered (unlike model-authored JS), yet 21's resume replays the orchestration body -
 * so an accidental `Date.now()`/`Math.random()` in a built-in silently desyncs the ordinal cache. This
 * harness runs a built-in TWICE with `Date.now` and `Math.random` each pinned to two DIFFERENT fixed
 * values (valid numbers, so the Effect runtime keeps working), then compares the emitted
 * `workflow.agent` (ordinal + `(prompt,opts)` fingerprint) sequence: a body that branches on - or
 * derives a prompt from - the clock or RNG produces a different sequence across the two values and is
 * caught, before it silently desyncs a resumed run. Every built-in (the fleet first) passes it.
 *
 * A TEST utility (it briefly patches `Date.now`/`Math.random`), meant to run a built-in in isolation.
 *
 * Responsible for: the run-twice-under-varied-clock/RNG determinism check over a built-in.
 * Not for: running a workflow normally (engine.ts) or the DSL static determinism check (spec.ts).
 */
import { Effect } from "effect";
import type { LeafRunner } from "./engine";
import { type EngineDeps, runWorkflow, type WorkflowBody } from "./engine";

export interface DeterminismReport {
  readonly deterministic: boolean;
  /** The `workflow.agent` ordinal sequence from each of the two passes (for a divergence diff). */
  readonly passes: readonly (readonly string[])[];
  /** Set when non-deterministic: what broke (a forbidden-RNG throw, or a diverged ordinal sequence). */
  readonly divergence?: string;
}

interface Varied {
  readonly time: number;
  readonly random: number;
}

/** Each `workflow.agent` as `ordinal#fingerprint` - the exact key resume replays by, so a diverged
 *  sequence is precisely a diverged resume. */
async function runPass(
  name: string,
  body: WorkflowBody,
  args: unknown,
  leafRunner: LeafRunner,
  varied: Varied,
): Promise<readonly string[]> {
  const keys: string[] = [];
  const deps: EngineDeps = {
    runId: `determinism-${varied.time}`,
    emit: (event) =>
      Effect.sync(() => {
        if (event.type === "workflow.agent") {
          const ordinal = (event.payload.ordinal as number[]).join(".");
          keys.push(`${ordinal}#${event.payload.fingerprint as string}`);
        }
      }),
    leafRunner,
  };

  const originalNow = Date.now;
  const originalRandom = Math.random;
  Date.now = () => varied.time;
  Math.random = () => varied.random;
  try {
    await Effect.runPromise(runWorkflow(name, body, args, deps));
    return keys;
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
  }
}

/**
 * Run `body` twice under two different fixed clock/RNG values and compare the emitted
 * (ordinal + fingerprint) sequence. `deterministic` is true only when the two sequences are identical.
 * `leafRunner` must itself be deterministic (a test fake) so any divergence is the body's.
 */
export async function checkDeterminism(
  name: string,
  body: WorkflowBody,
  args: unknown,
  leafRunner: LeafRunner,
): Promise<DeterminismReport> {
  const first = await runPass(name, body, args, leafRunner, { time: 1_000_000, random: 0.123456 });
  const second = await runPass(name, body, args, leafRunner, { time: 2_000_000, random: 0.987654 });
  const passes = [first, second] as const;

  if (JSON.stringify(first) !== JSON.stringify(second)) {
    return {
      deterministic: false,
      passes,
      divergence: `the run diverged across two clock/RNG values (a built-in read a clock/RNG): ${JSON.stringify(first)} vs ${JSON.stringify(second)}`,
    };
  }
  return { deterministic: true, passes };
}
