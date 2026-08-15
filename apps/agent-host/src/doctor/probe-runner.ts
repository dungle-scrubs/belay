import type { DoctorFinding } from "@belay/session";

/**
 * Bounded `/doctor` probe execution (D-073 M3).
 *
 * Live checks (provider reachability, runtime pings, catalog fetches) must never let one slow or hung
 * call block the whole command. This runner gives every probe a short per-check timeout AND caps the
 * total run at an overall budget: a probe that overruns its timeout, or one reached after the budget
 * is spent, degrades to a `not_checked` finding carrying a next action ("re-run") instead of hanging.
 * An authoritative cached result is reused WITHOUT running the live probe at all.
 *
 * The overall-budget clock is injected (`now`), so budget exhaustion is deterministic in tests; the
 * per-check timeout uses a real timer (race). The runner mutates nothing - it only reads each probe
 * and returns fresh findings - so it satisfies "/doctor does not mutate state" by construction.
 *
 * Responsible for: bounded probe execution - per-check timeouts, an overall budget, cache reuse.
 * Not for: what to probe - build.ts collects the actual provider/root checks.
 */

/** A live diagnostic probe: a stable id/title plus either an authoritative cached result or a runner. */
export interface DoctorProbe {
  readonly id: string;
  readonly title: string;
  /** A previously-computed result; reused without running when `authoritative` (D-073 M3). */
  readonly cached?: { readonly finding: DoctorFinding; readonly authoritative: boolean };
  /** The live check. Only invoked when there is no authoritative cached result. */
  readonly run: () => Promise<DoctorFinding>;
}

/** The time bounds for a `/doctor` run: a per-check timeout and an overall budget, over a clock. */
export interface ProbeBudget {
  readonly perCheckMs: number;
  readonly overallMs: number;
  /** Monotonic milliseconds; injected so overall-budget accounting is deterministic. */
  readonly now: () => number;
}

type RaceResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "timeout" }
  | { readonly kind: "error"; readonly error: unknown };

/** Races a promise against a per-check timeout, distinguishing resolve / timeout / rejection. */
function race<T>(p: Promise<T>, ms: number): Promise<RaceResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: RaceResult<T>) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const timer = setTimeout(() => done({ kind: "timeout" }), ms);
    // Don't let the timeout keep the process alive if everything else is idle.
    (timer as { unref?: () => void }).unref?.();
    p.then(
      (value) => {
        clearTimeout(timer);
        done({ kind: "ok", value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        done({ kind: "error", error });
      },
    );
  });
}

/** A `not_checked` degradation finding with a re-run next action; `message` says why it degraded. */
function degraded(probe: DoctorProbe, message: string, evidence?: string): DoctorFinding {
  return {
    id: probe.id,
    status: "not_checked",
    title: probe.title,
    message,
    ...(evidence ? { evidence } : {}),
    nextAction: { label: "Re-run /doctor to retry this check" },
  };
}

/**
 * Runs the probes in order under the budget, returning one finding each. An authoritative cache is
 * reused as-is; otherwise the probe runs with a timeout of `min(perCheckMs, remaining budget)`. A
 * timeout, a rejection, or reaching a probe after the budget is spent all degrade to a `not_checked`
 * finding with a re-run action - so the command stays bounded and never blocks on a hung check.
 */
export async function runDoctorProbes(
  probes: readonly DoctorProbe[],
  budget: ProbeBudget,
): Promise<DoctorFinding[]> {
  const startedAt = budget.now();
  const findings: DoctorFinding[] = [];

  for (const probe of probes) {
    if (probe.cached?.authoritative) {
      findings.push(probe.cached.finding); // reuse authoritative cached state - no live call
      continue;
    }

    const remaining = budget.overallMs - (budget.now() - startedAt);
    if (remaining <= 0) {
      findings.push(
        degraded(probe, "Skipped - the /doctor time budget was reached before this check."),
      );
      continue;
    }

    const result = await race(probe.run(), Math.min(budget.perCheckMs, remaining));
    if (result.kind === "ok") {
      findings.push(result.value);
    } else if (result.kind === "timeout") {
      findings.push(degraded(probe, "Check timed out before it answered."));
    } else {
      const name = result.error instanceof Error ? result.error.name : "error";
      findings.push(degraded(probe, "Check failed to run.", name));
    }
  }

  return findings;
}
