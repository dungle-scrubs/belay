import assert from "node:assert/strict";
import type { DoctorFinding } from "@belay/session";
import { test } from "vitest";
import { type DoctorProbe, type ProbeBudget, runDoctorProbes } from "./probe-runner";

/**
 * D-073 M3: bounded `/doctor` probe execution. Pins per-check timeout degradation, overall-budget
 * skip, authoritative-cache reuse, probe-rejection degradation, the no-mutation property, and a
 * bounded overall runtime. The overall-budget clock is injected; probes consume it like real time.
 */

const ok = (id: string): DoctorFinding => ({
  id,
  status: "ok",
  title: id,
  message: `${id} ok`,
});

/** A probe whose run resolves immediately and advances the injected clock by `costMs`. */
function fastProbe(id: string, clock: { ms: number }, costMs = 0): DoctorProbe {
  return {
    id,
    title: id,
    run: () => {
      clock.ms += costMs;
      return Promise.resolve(ok(id));
    },
  };
}

const budget = (clock: { ms: number }, over: Partial<ProbeBudget> = {}): ProbeBudget => ({
  perCheckMs: 50,
  overallMs: 1000,
  now: () => clock.ms,
  ...over,
});

test("fast probes all run and return their findings in order", async () => {
  const clock = { ms: 0 };
  const out = await runDoctorProbes(
    [fastProbe("a", clock), fastProbe("b", clock), fastProbe("c", clock)],
    budget(clock),
  );
  assert.deepEqual(
    out.map((f) => [f.id, f.status]),
    [
      ["a", "ok"],
      ["b", "ok"],
      ["c", "ok"],
    ],
  );
});

test("a probe that overruns the per-check timeout degrades to not_checked with a re-run action", async () => {
  const clock = { ms: 0 };
  const slow: DoctorProbe = {
    id: "slow",
    title: "Slow check",
    // Resolves long after the 10ms per-check timeout; the timer wins.
    run: () => new Promise((resolve) => setTimeout(() => resolve(ok("slow")), 1000)),
  };
  const [finding] = await runDoctorProbes([slow], budget(clock, { perCheckMs: 10 }));
  assert.equal(finding?.status, "not_checked");
  assert.match(finding?.message ?? "", /timed out/i);
  assert.ok(finding?.nextAction, "a timed-out check still offers a next action");
});

test("once the overall budget is spent, later probes are skipped to not_checked", async () => {
  const clock = { ms: 0 };
  // Each probe consumes 60ms of the injected clock; with a 100ms overall budget, the third is reached
  // after 120ms elapsed and is skipped without running.
  const out = await runDoctorProbes(
    [fastProbe("a", clock, 60), fastProbe("b", clock, 60), fastProbe("c", clock, 60)],
    budget(clock, { overallMs: 100 }),
  );
  assert.deepEqual(
    out.map((f) => [f.id, f.status]),
    [
      ["a", "ok"],
      ["b", "ok"],
      ["c", "not_checked"],
    ],
  );
  assert.match(out[2]?.message ?? "", /budget/i, "the skipped check says the budget was reached");
});

test("an authoritative cached result is reused without running the live probe", async () => {
  const clock = { ms: 0 };
  let ran = false;
  const cached: DoctorProbe = {
    id: "providers",
    title: "Providers",
    cached: {
      finding: { id: "providers", status: "ok", title: "Providers", message: "cached" },
      authoritative: true,
    },
    run: () => {
      ran = true;
      return Promise.resolve(ok("providers"));
    },
  };
  const [finding] = await runDoctorProbes([cached], budget(clock));
  assert.equal(finding?.message, "cached", "the cached finding is returned as-is");
  assert.equal(ran, false, "the live probe is never invoked when the cache is authoritative");
});

test("a NON-authoritative cache still runs the live probe", async () => {
  const clock = { ms: 0 };
  let ran = false;
  const probe: DoctorProbe = {
    id: "p",
    title: "P",
    cached: { finding: ok("p"), authoritative: false },
    run: () => {
      ran = true;
      return Promise.resolve({ id: "p", status: "warn", title: "P", message: "live" });
    },
  };
  const [finding] = await runDoctorProbes([probe], budget(clock));
  assert.equal(ran, true);
  assert.equal(finding?.message, "live");
});

test("a probe that rejects degrades to not_checked with a sanitized (name-only) evidence", async () => {
  const clock = { ms: 0 };
  const failing: DoctorProbe = {
    id: "boom",
    title: "Boom",
    run: () => Promise.reject(new TypeError("connect ECONNREFUSED 10.0.0.1:443 secret-token")),
  };
  const [finding] = await runDoctorProbes([failing], budget(clock));
  assert.equal(finding?.status, "not_checked");
  assert.equal(
    finding?.evidence,
    "TypeError",
    "only the error name, never its raw message, is kept",
  );
  assert.ok(!(finding?.evidence ?? "").includes("ECONNREFUSED"), "no raw error detail leaks");
});

test("the runner does not mutate the input probe list and stays within a bounded runtime", async () => {
  const clock = { ms: 0 };
  const probes = [fastProbe("a", clock), fastProbe("b", clock)];
  const snapshot = [...probes];
  const startWall = Date.now();
  await runDoctorProbes(probes, budget(clock, { perCheckMs: 20, overallMs: 100 }));
  assert.deepEqual(probes, snapshot, "the input list is untouched (no mutation)");
  // With fast probes the whole run is far under any real-time bound; this guards against accidental
  // serialization on real timers for the all-fast path.
  assert.ok(Date.now() - startWall < 500, "fast probes complete well within a bounded runtime");
});
