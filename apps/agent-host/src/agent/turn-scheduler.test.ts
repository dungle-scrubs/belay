import assert from "node:assert/strict";
import type { SessionEvent } from "@trevor/session";
import { test } from "vitest";
import { type ActiveTurn, TurnScheduler } from "./turn-scheduler";

/**
 * Characterization tests for the turn scheduler (M1 / D-004).
 *
 * These pin the EXACT dispatch behavior the current `main.ts` turn machine
 * produces. The scheduler is driven through its two inbound LIFECYCLE entry points
 * (`noteTurn`, `processCompletion`) plus the recovery hooks - never the internal
 * micro-mutations (`submit`/`recordAnswer`/`drain`/`maybeCompact`/`noteAttempt`),
 * which are now private. The behavior pinned:
 *   - exactly one turn runs at a time; a prompt that arrives mid-turn is queued (FIFO)
 *   - a completion frees the slot and (when leader) drains the next prompt, then folds
 *     proactively if over budget - all in one `processCompletion`, in that order
 *   - the fiber backstop (`settle`) frees the slot WITHOUT draining (draining is tied
 *     to the completion event, which is also when the prior reply enters history)
 *   - a non-leader records the prompt but starts no turn; on becoming leader it
 *     catches up the latest still-unanswered prompt
 *   - a cancel interrupts the active run (matching runId, or "" = whatever is active)
 *   - reconnect clears the queue but leaves an in-flight run intact
 *
 * The scheduler is exercised as a pure state machine: `start` is a mock that returns
 * a fake `ActiveTurn` when "leader" and null otherwise, recording every call. The real
 * `start` (in main.ts) admits the event to history and forks the turn fiber. `noteTurn`
 * decodes the event to dispatch, so the test events are real (decodable) session events.
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

/** An assistant.started for the attempt watermark (the prompt's turn began streaming). */
function startedEv(runId: string, seq = counter++): SessionEvent {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    eventId: `e${seq}`,
    payload: { runId },
    producerId: "trevor-host",
    seq,
    sessionId: "test",
    type: "assistant.started",
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

test("idle prompt starts now; mid-turn prompts defer and drain FIFO on completion", () => {
  const h = harness();
  const a = userEv("a");
  const b = userEv("b");
  const c = userEv("c");

  h.scheduler.noteTurn(a);
  assert.equal(h.scheduler.isBusy(), true);
  assert.deepEqual(h.started, [a]);

  h.scheduler.noteTurn(b); // busy -> deferred
  h.scheduler.noteTurn(c); // busy -> deferred
  assert.deepEqual(h.started, [a]);
  assert.equal(h.scheduler.debug().queued, 2);

  // a completes -> free the slot, drain b (one lifecycle call owns the ordering)
  h.scheduler.processCompletion("run0", a.seq);
  assert.deepEqual(h.started, [a, b]);

  // b completes -> drain c
  h.scheduler.processCompletion("run1", b.seq);
  assert.deepEqual(h.started, [a, b, c]);
  assert.equal(h.scheduler.debug().queued, 0);
});

test("processCompletion drains the next queued prompt in one call (no caller-side sequencing)", () => {
  const h = harness();
  h.scheduler.noteTurn(userEv("a")); // run0 active
  h.scheduler.noteTurn(userEv("b")); // queued
  // The completion event alone frees run0 AND drains b - the caller never orders
  // recordAnswer -> drain by hand (the old implicit, skippable contract).
  h.scheduler.processCompletion("run0", 0);
  assert.equal(h.started.length, 2, "the completion freed run0 and drained b");
  assert.equal(h.scheduler.debug().queued, 0);
});

test("only one turn is ever active (a second prompt never overlaps)", () => {
  const h = harness();
  h.scheduler.noteTurn(userEv("a"));
  h.scheduler.noteTurn(userEv("b"));
  assert.equal(h.started.length, 1);
  assert.equal(h.scheduler.isBusy(), true);
  assert.equal(h.scheduler.debug().queued, 1);
});

test("the fiber backstop frees the slot but does NOT drain (drain is tied to completion)", () => {
  const h = harness();
  h.scheduler.noteTurn(userEv("a"));
  h.scheduler.noteTurn(userEv("b")); // queued
  h.scheduler.settle("run0"); // a's fiber settled
  assert.equal(h.scheduler.isBusy(), false);
  assert.equal(h.started.length, 1); // b NOT started by settle alone
  h.scheduler.processCompletion("run0", 0); // the completion event drains
  assert.equal(h.started.length, 2); // now b starts
});

test("a stale completion never clears the wrong active run", () => {
  const h = harness();
  h.scheduler.noteTurn(userEv("a")); // run0
  h.scheduler.settle("run0"); // ...frees the slot, nothing queued
  h.scheduler.noteTurn(userEv("b")); // run1, now active
  // a late completion for the already-settled run0 must not clear run1
  h.scheduler.processCompletion("run0", 0);
  assert.equal(h.scheduler.isBusy(), true);
});

test("cancel interrupts the active run by runId, and '' cancels whatever is active", () => {
  const h1 = harness();
  h1.scheduler.noteTurn(userEv("a")); // run0
  h1.scheduler.cancel("run0");
  assert.deepEqual(h1.cancelled, ["run0"]);

  const h2 = harness();
  h2.scheduler.noteTurn(userEv("a")); // run0
  h2.scheduler.cancel(""); // wildcard
  assert.deepEqual(h2.cancelled, ["run0"]);

  const h3 = harness();
  h3.scheduler.noteTurn(userEv("a")); // run0
  h3.scheduler.cancel("other"); // non-matching -> no-op
  assert.deepEqual(h3.cancelled, []);
});

test("a non-leader records prompts but starts no turn; becoming leader catches up the latest", () => {
  const h = harness({ leader: false });
  const first = userEv("first");
  const second = userEv("second");
  h.scheduler.noteTurn(first); // recorded, no turn (standby)
  h.scheduler.noteTurn(second);
  assert.equal(h.scheduler.isBusy(), false);
  assert.deepEqual(h.started, [first, second]); // start (admit) ran, returned null

  // The latest unanswered prompt is the catch-up target.
  assert.equal(h.scheduler.pendingCatchUp(), second);

  h.setLeader(true);
  const pending = h.scheduler.pendingCatchUp();
  assert.ok(pending);
  h.scheduler.noteTurn(pending);
  assert.equal(h.scheduler.isBusy(), true);
});

test("pendingCatchUp is null once the latest prompt has been answered", () => {
  const h = harness();
  const a = userEv("a");
  h.scheduler.noteTurn(a);
  h.scheduler.processCompletion("run0", a.seq);
  assert.equal(h.scheduler.pendingCatchUp(), null);
});

test("catch-up does NOT re-run a prompt already attempted (orphaned by a crash/restart)", () => {
  // The prompt was submitted and a turn STARTED for it (assistant.started -> noteAttempt), but the
  // host restarted before any completion. On replay the prompt is unanswered - yet it must NOT be
  // auto-re-run: the orphan reap closes it and the host idles. Without this, every restart loops,
  // re-running and re-cancelling the same prompt.
  const h = harness({ leader: false });
  const p = userEv("read the whole codebase");
  h.scheduler.noteTurn(p);
  // a turn's assistant.started landed (seq after the prompt) -> noteTurn records the attempt
  h.scheduler.noteTurn(startedEv("run0", p.seq + 1));
  assert.equal(h.scheduler.pendingCatchUp(), null, "an attempted prompt is never caught up");
});

test("catch-up DOES re-run a never-attempted prompt (arrived during a leadership gap)", () => {
  const h = harness({ leader: false });
  const p = userEv("hello");
  h.scheduler.noteTurn(p); // recorded while standby; no host ever started a turn for it
  assert.equal(h.scheduler.pendingCatchUp(), p, "a never-attempted prompt is caught up");
});

test("drain holds the queue when not leader", () => {
  const h = harness();
  h.scheduler.noteTurn(userEv("a")); // run0 active
  h.scheduler.noteTurn(userEv("b")); // queued
  h.scheduler.settle("run0");
  h.setLeader(false);
  h.scheduler.processCompletion("run0", 0); // would drain, but not leader -> hold
  assert.equal(h.started.length, 1);
  assert.equal(h.scheduler.debug().queued, 1);
});

test("/clear drops queued prompts and the catch-up target but keeps the active run", () => {
  const h = harness();
  const a = userEv("a");
  h.scheduler.noteTurn(a); // run0 active
  h.scheduler.noteTurn(userEv("b")); // queued
  h.scheduler.clearPending();
  assert.equal(h.scheduler.isBusy(), true); // active run survives a clear
  assert.equal(h.scheduler.debug().queued, 0); // queued prompts dropped
  assert.equal(h.scheduler.pendingCatchUp(), null); // catch-up target dropped
});

test("reconnect clears the queue but leaves an in-flight run intact", () => {
  const h = harness();
  h.scheduler.noteTurn(userEv("a")); // run0 active
  h.scheduler.noteTurn(userEv("b")); // queued
  h.scheduler.resetForReconnect();
  assert.equal(h.scheduler.isBusy(), true); // active run survives reconnect
  assert.equal(h.scheduler.debug().queued, 0); // queue cleared
});

/**
 * Compaction gating (D-041): the scheduler holds turns behind a fold. `compaction.needed()` reports
 * whether the projection is over budget (the host flips it false after a fold) and `compaction.run()`
 * kicks one off; `finishCompaction` releases the gate. Exercised as a state machine with stub deps.
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
    compaction: {
      needed: () => overBudget,
      run: () => {
        compactCalls += 1;
      },
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

test("blocking-before: an over-budget prompt defers behind a fold, then starts on finish", () => {
  const h = compactionHarness();
  h.setOverBudget(true);
  const a = userEv("a");

  h.scheduler.noteTurn(a);
  // Over budget: a fold is kicked off and the turn is held - it must NOT start over budget.
  assert.equal(h.compactCalls(), 1, "a blocking fold was kicked off");
  assert.deepEqual(h.started, [], "the turn did not start over budget");
  assert.equal(h.scheduler.isBusy(), false);
  assert.equal(h.scheduler.debug().compacting, true);

  // A prompt arriving mid-fold is held too.
  h.scheduler.noteTurn(userEv("b"));
  assert.equal(h.scheduler.debug().queued, 2, "deferred turn + the mid-fold prompt both wait");

  // The host folds, flips the budget, and signals: the deferred turn starts (b stays queued).
  h.setOverBudget(false);
  h.scheduler.finishCompaction();
  assert.deepEqual(h.started, [a], "the deferred turn starts once under budget");
  assert.equal(h.scheduler.isBusy(), true);
  assert.equal(h.scheduler.debug().compacting, false);
});

test("background-after: processCompletion folds proactively when the freed slot is idle + over budget", () => {
  const h = compactionHarness();

  // A turn runs under budget, then crosses the budget while streaming.
  h.scheduler.noteTurn(userEv("a")); // run0 active, started
  h.setOverBudget(true);

  // The completion frees the slot; with nothing queued and over budget, a proactive fold fires -
  // recordAnswer -> drain (empty) -> maybeCompact, all owned by processCompletion.
  h.scheduler.processCompletion("run0", 0);
  assert.equal(h.compactCalls(), 1, "over budget + idle: a proactive fold runs after draining");
  assert.equal(h.scheduler.debug().compacting, true);
  assert.equal(h.started.length, 1, "no new turn started for a background fold");

  // Nothing queued: finishing just clears the gate.
  h.setOverBudget(false);
  h.scheduler.finishCompaction();
  assert.equal(h.scheduler.debug().compacting, false);
});

test("a completion under budget evaluates the gate and folds nothing", () => {
  const h = compactionHarness();
  h.scheduler.noteTurn(userEv("a")); // run0 active
  h.scheduler.processCompletion("run0", 0); // under budget: gate evaluated, no fold
  assert.equal(h.compactCalls(), 0, "under budget: nothing to do");
  assert.equal(h.scheduler.debug().compacting, false);
});

test("compaction gating is inert when the scheduler has no compaction deps", () => {
  // The plain harness (no compaction policy) starts turns immediately - compaction is opt-in.
  const h = harness();
  h.scheduler.noteTurn(userEv("a"));
  assert.equal(h.scheduler.isBusy(), true);
  h.scheduler.processCompletion("run0", 0); // exercises the (no-op) maybeCompact path
  assert.equal(h.scheduler.debug().compacting, false);
});
