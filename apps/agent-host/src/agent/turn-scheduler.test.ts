import assert from "node:assert/strict";
import type { SessionEvent } from "@trevor/session";
import { test } from "vitest";
import { type ActiveTurn, TurnScheduler } from "./turn-scheduler";

/**
 * Characterization tests for the turn scheduler (M6 / D-006).
 *
 * These pin the EXACT dispatch behavior the current `main.ts` turn machine
 * produces, BEFORE it is extracted, so the extraction is proven behavior-
 * preserving. The current behavior, scattered across main.ts module mutables
 * (`activeRun`, `deferredUserEvents`, `lastUserEvent`, `lastAnswerSeq`) and the
 * `respondTo` / `handleUserMessage` / `drainDeferred` / `onBecomeLeader` functions:
 *   - exactly one turn runs at a time; a prompt that arrives mid-turn is queued (FIFO)
 *   - a completion frees the slot and (only when live + leader) drains the next prompt
 *   - the fiber backstop frees the slot WITHOUT draining (draining is tied to the
 *     completion event, which is also when the prior reply enters history)
 *   - a non-leader records the prompt but starts no turn; on becoming leader it
 *     catches up the latest still-unanswered prompt
 *   - a cancel interrupts the active run (matching runId, or "" = whatever is active)
 *   - reconnect clears the queue but leaves an in-flight run intact
 *
 * The scheduler is exercised as a pure state machine: `start` is a mock that returns
 * a fake `ActiveTurn` when "leader" and null otherwise, recording every call. The real
 * `start` (in main.ts) admits the event to history and forks the turn fiber.
 */

let counter = 0;
function userEv(text: string, seq = counter++): SessionEvent {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    eventId: `e${seq}`,
    payload: { text, provider: "qwen" },
    producerId: "trevor-web",
    seq,
    sessionId: "test",
    type: "user.message",
  };
}

function harness(opts: { leader?: boolean } = {}) {
  let leader = opts.leader ?? true;
  const started: SessionEvent[] = [];
  const cancelled: string[] = [];
  let runs = 0;
  const scheduler = new TurnScheduler({
    isLeader: () => leader,
    start: (event): ActiveTurn | null => {
      started.push(event);
      if (!leader) {
        return null; // recorded but not answered (standby / replay)
      }
      const runId = `run${runs++}`;
      return { runId, cancel: () => cancelled.push(runId) };
    },
  });
  return { scheduler, started, cancelled, setLeader: (v: boolean) => (leader = v) };
}

test("idle submit starts now; mid-turn submits defer and drain FIFO on completion", () => {
  const h = harness();
  const a = userEv("a");
  const b = userEv("b");
  const c = userEv("c");

  h.scheduler.submit(a);
  assert.equal(h.scheduler.isBusy(), true);
  assert.deepEqual(h.started, [a]);

  h.scheduler.submit(b); // busy -> deferred
  h.scheduler.submit(c); // busy -> deferred
  assert.deepEqual(h.started, [a]);
  assert.equal(h.scheduler.debug().queued, 2);

  // a completes -> free the slot, drain b
  h.scheduler.recordAnswer("run0", a.seq);
  h.scheduler.drain();
  assert.deepEqual(h.started, [a, b]);

  // b completes -> drain c
  h.scheduler.recordAnswer("run1", b.seq);
  h.scheduler.drain();
  assert.deepEqual(h.started, [a, b, c]);
  assert.equal(h.scheduler.debug().queued, 0);
});

test("only one turn is ever active (a second prompt never overlaps)", () => {
  const h = harness();
  h.scheduler.submit(userEv("a"));
  h.scheduler.submit(userEv("b"));
  assert.equal(h.started.length, 1);
  assert.equal(h.scheduler.isBusy(), true);
  assert.equal(h.scheduler.debug().queued, 1);
});

test("the fiber backstop frees the slot but does NOT drain (drain is tied to completion)", () => {
  const h = harness();
  h.scheduler.submit(userEv("a"));
  h.scheduler.submit(userEv("b")); // queued
  h.scheduler.settle("run0"); // a's fiber settled
  assert.equal(h.scheduler.isBusy(), false);
  assert.equal(h.started.length, 1); // b NOT started by settle alone
  h.scheduler.drain();
  assert.equal(h.started.length, 2); // now b starts
});

test("a stale completion never clears the wrong active run", () => {
  const h = harness();
  h.scheduler.submit(userEv("a")); // run0
  h.scheduler.settle("run0");
  h.scheduler.drain(); // ...nothing queued, stays idle
  h.scheduler.submit(userEv("b")); // run1, now active
  // a late completion for the already-settled run0 must not clear run1
  h.scheduler.recordAnswer("run0", 0);
  assert.equal(h.scheduler.isBusy(), true);
});

test("cancel interrupts the active run by runId, and '' cancels whatever is active", () => {
  const h1 = harness();
  h1.scheduler.submit(userEv("a")); // run0
  h1.scheduler.cancel("run0");
  assert.deepEqual(h1.cancelled, ["run0"]);

  const h2 = harness();
  h2.scheduler.submit(userEv("a")); // run0
  h2.scheduler.cancel(""); // wildcard
  assert.deepEqual(h2.cancelled, ["run0"]);

  const h3 = harness();
  h3.scheduler.submit(userEv("a")); // run0
  h3.scheduler.cancel("other"); // non-matching -> no-op
  assert.deepEqual(h3.cancelled, []);
});

test("a non-leader records prompts but starts no turn; becoming leader catches up the latest", () => {
  const h = harness({ leader: false });
  const first = userEv("first");
  const second = userEv("second");
  h.scheduler.submit(first); // recorded, no turn (standby)
  h.scheduler.submit(second);
  assert.equal(h.scheduler.isBusy(), false);
  assert.deepEqual(h.started, [first, second]); // start (admit) ran, returned null

  // The latest unanswered prompt is the catch-up target.
  assert.equal(h.scheduler.pendingCatchUp(), second);

  h.setLeader(true);
  const pending = h.scheduler.pendingCatchUp();
  assert.ok(pending);
  h.scheduler.submit(pending);
  assert.equal(h.scheduler.isBusy(), true);
});

test("pendingCatchUp is null once the latest prompt has been answered", () => {
  const h = harness();
  const a = userEv("a");
  h.scheduler.submit(a);
  h.scheduler.recordAnswer("run0", a.seq);
  assert.equal(h.scheduler.pendingCatchUp(), null);
});

test("catch-up does NOT re-run a prompt already attempted (orphaned by a crash/restart)", () => {
  // The prompt was submitted and a turn STARTED for it (assistant.started -> noteAttempt), but the
  // host restarted before any completion. On replay the prompt is unanswered - yet it must NOT be
  // auto-re-run: the orphan reap closes it and the host idles. Without this, every restart loops,
  // re-running and re-cancelling the same prompt.
  const h = harness({ leader: false });
  const p = userEv("read the whole codebase");
  h.scheduler.submit(p);
  h.scheduler.noteAttempt(p.seq + 1); // a turn's assistant.started landed (seq after the prompt)
  assert.equal(h.scheduler.pendingCatchUp(), null, "an attempted prompt is never caught up");
});

test("catch-up DOES re-run a never-attempted prompt (arrived during a leadership gap)", () => {
  const h = harness({ leader: false });
  const p = userEv("hello");
  h.scheduler.submit(p); // recorded while standby; no host ever started a turn for it
  assert.equal(h.scheduler.pendingCatchUp(), p, "a never-attempted prompt is caught up");
});

test("drain holds the queue when not leader", () => {
  const h = harness();
  h.scheduler.submit(userEv("a")); // run0 active
  h.scheduler.submit(userEv("b")); // queued
  h.scheduler.settle("run0");
  h.setLeader(false);
  h.scheduler.drain(); // not leader -> hold
  assert.equal(h.started.length, 1);
  assert.equal(h.scheduler.debug().queued, 1);
});

test("/clear drops queued prompts and the catch-up target but keeps the active run", () => {
  const h = harness();
  const a = userEv("a");
  h.scheduler.submit(a); // run0 active
  h.scheduler.submit(userEv("b")); // queued
  h.scheduler.clearPending();
  assert.equal(h.scheduler.isBusy(), true); // active run survives a clear
  assert.equal(h.scheduler.debug().queued, 0); // queued prompts dropped
  assert.equal(h.scheduler.pendingCatchUp(), null); // catch-up target dropped
});

test("reconnect clears the queue but leaves an in-flight run intact", () => {
  const h = harness();
  h.scheduler.submit(userEv("a")); // run0 active
  h.scheduler.submit(userEv("b")); // queued
  h.scheduler.resetForReconnect();
  assert.equal(h.scheduler.isBusy(), true); // active run survives reconnect
  assert.equal(h.scheduler.debug().queued, 0); // queue cleared
});

/**
 * Compaction gating (D-041): the scheduler holds turns behind a fold. `needsCompaction` reports
 * whether the projection is over budget (the host flips it false after a fold) and `compact` kicks
 * one off; `finishCompaction` releases the gate. Exercised as a state machine with stub deps.
 */
function compactionHarness() {
  const started: SessionEvent[] = [];
  let overBudget = false;
  let compactCalls = 0;
  const scheduler = new TurnScheduler({
    isLeader: () => true,
    start: (event): ActiveTurn | null => {
      started.push(event);
      return { runId: `run${started.length - 1}`, cancel: () => {} };
    },
    needsCompaction: () => overBudget,
    compact: () => {
      compactCalls += 1;
    },
  });
  return {
    scheduler,
    started,
    setOverBudget: (v: boolean) => {
      overBudget = v;
    },
    compactCalls: () => compactCalls,
  };
}

test("blocking-before: an over-budget submit defers behind a fold, then starts on finish", () => {
  const h = compactionHarness();
  h.setOverBudget(true);
  const a = userEv("a");

  h.scheduler.submit(a);
  // Over budget: a fold is kicked off and the turn is held - it must NOT start over budget.
  assert.equal(h.compactCalls(), 1, "a blocking fold was kicked off");
  assert.deepEqual(h.started, [], "the turn did not start over budget");
  assert.equal(h.scheduler.isBusy(), false);
  assert.equal(h.scheduler.debug().compacting, true);

  // A prompt arriving mid-fold is held too.
  h.scheduler.submit(userEv("b"));
  assert.equal(h.scheduler.debug().queued, 2, "deferred turn + the mid-fold prompt both wait");

  // The host folds, flips the budget, and signals: the deferred turn starts (b stays queued).
  h.setOverBudget(false);
  h.scheduler.finishCompaction();
  assert.deepEqual(h.started, [a], "the deferred turn starts once under budget");
  assert.equal(h.scheduler.isBusy(), true);
  assert.equal(h.scheduler.debug().compacting, false);
});

test("background-after: maybeCompact folds proactively when idle and over budget", () => {
  const h = compactionHarness();

  h.scheduler.maybeCompact();
  assert.equal(h.compactCalls(), 0, "under budget: nothing to do");

  h.setOverBudget(true);
  h.scheduler.maybeCompact();
  assert.equal(h.compactCalls(), 1, "over budget + idle: a proactive fold runs");
  assert.equal(h.scheduler.debug().compacting, true);
  assert.deepEqual(h.started, [], "no turn started for a background fold");

  // Nothing queued: finishing just clears the gate.
  h.setOverBudget(false);
  h.scheduler.finishCompaction();
  assert.equal(h.scheduler.debug().compacting, false);
});

test("compaction gating is inert when the scheduler has no compaction deps", () => {
  // The plain harness (no needsCompaction/compact) starts turns immediately - compaction is opt-in.
  const h = harness();
  h.scheduler.submit(userEv("a"));
  assert.equal(h.scheduler.isBusy(), true);
  h.scheduler.maybeCompact(); // no-op, no deps
  assert.equal(h.scheduler.debug().compacting, false);
});
