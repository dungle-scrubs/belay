/**
 * The detached durable-run lifecycle (plan 21 M7, D-018 - the primitive the audit found neither plan
 * owned concretely). A run is entered as a DETACHED durable background session: the run session is
 * ensured (via 15's forkable-session spawning), the workflow runs in a background daemon fiber, and on
 * completion the LAUNCHER is notified with a run-completion notification DISTINCT from the
 * `delegated.to` fold-back. The launching session is NEITHER switched NOR retired (contrast handoff's
 * switch+retire): `startDetachedRun` returns immediately, so the launcher keeps working and is merely
 * notified later. The fleet (46) rides this directly.
 *
 * Responsible for: the ensure-session -> fork-in-background -> notify-on-completion lifecycle, with the
 * session-spawn and notify collaborators injected.
 * Not for: running the workflow itself (engine.ts) or the real transport/15 wiring (the host composes
 * the seams).
 */
import { Effect, type Fiber } from "effect";
import type { RunResult } from "./engine";

export interface DetachedRunDeps {
  readonly runId: string;
  /** Create/ensure the durable run session (15's session spawning) - NOT a switch/retire. */
  readonly ensureRunSession: (runId: string) => Effect.Effect<void>;
  /** The workflow run to execute (from `runWorkflow`); never throws (a body failure is in `RunResult`). */
  readonly run: Effect.Effect<RunResult>;
  /** Notify the LAUNCHER on completion - a run-completion notification, distinct from `delegated.to`. */
  readonly notifyLauncher: (runId: string, summary: RunResult) => Effect.Effect<void>;
}

export interface DetachedRunHandle {
  readonly runId: string;
  /** The background fiber, so a caller can await it (tests) or cancel the run (user hard-cancel). */
  readonly fiber: Fiber.RuntimeFiber<RunResult, never>;
}

/**
 * Start a detached durable run. Ensures the run session, forks the run as a background daemon fiber
 * that notifies the launcher on completion, and returns IMMEDIATELY - the launching session survives
 * (not switched/retired) and is notified later (D-018).
 */
export function startDetachedRun(deps: DetachedRunDeps): Effect.Effect<DetachedRunHandle> {
  return Effect.gen(function* () {
    yield* deps.ensureRunSession(deps.runId);
    const fiber = yield* Effect.forkDaemon(
      deps.run.pipe(Effect.tap((summary) => deps.notifyLauncher(deps.runId, summary))),
    );
    return { runId: deps.runId, fiber };
  });
}
