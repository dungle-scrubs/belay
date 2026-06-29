import assert from "node:assert/strict";
import { test } from "vitest";
import type { Provider } from "../providers";
import { CompactionController } from "./compaction-controller";

/** A minimal stand-in provider: the controller only reads its identity (`id`/`model`) for the
 *  foreground-change re-anchor and carries it through for fold/control prompts. */
function fakeProvider(id: string, model = id): Provider {
  return { id, model, kind: "cloud" } as Provider;
}

/**
 * 03.1 M1: the read-only `usageSeed()` accessor carries the prior turn's measured prompt size +
 * served window forward so the next turn's context-pressure gate can evaluate at step 0. It mirrors
 * the controller's captured state (`noteUsage` / `noteTurnCompleted` / `noteCompacted`) and is absent
 * until a turn has reported a positive window, so a session's first turn seeds nothing.
 */

test("usageSeed is undefined before any usage is noted", () => {
  const controller = new CompactionController(undefined);
  assert.equal(controller.usageSeed(), undefined);
});

test("usageSeed returns the latest captured usage after noteUsage", () => {
  const controller = new CompactionController(undefined);
  controller.noteUsage(1200, 8000);
  assert.deepEqual(controller.usageSeed(), { input: 1200, contextWindow: 8000 });
});

test("usageSeed returns the latest usage after noteTurnCompleted", () => {
  const controller = new CompactionController(undefined);
  controller.noteUsage(1200, 8000);
  controller.noteTurnCompleted({ input: 3400, contextWindow: 8000 });
  assert.deepEqual(controller.usageSeed(), { input: 3400, contextWindow: 8000 });
});

test("usageSeed reflects the post-fold input after noteCompacted", () => {
  const controller = new CompactionController(undefined);
  controller.noteUsage(6000, 8000);
  controller.noteCompacted({ throughSeq: 10, tokensBefore: 6000, tokensAfter: 2500 });
  assert.deepEqual(controller.usageSeed(), { input: 2500, contextWindow: 8000 });
});

test("usageSeed stays undefined when only a fold with no prior window is noted", () => {
  const controller = new CompactionController(undefined);
  controller.noteCompacted({ throughSeq: 1, tokensBefore: 0, tokensAfter: 0 });
  assert.equal(controller.usageSeed(), undefined);
});

/**
 * 03.2 M1: the over-budget trigger must read the SAME assembled-history chars/4 estimate the pre-send
 * guard and the planner already measure in, not just the provider's reported `input`. A provider that
 * under-counts (cached/billable input below the full prompt) otherwise hides a history the guard later
 * trips on, so the fold never schedules - exactly the session that overflowed with zero folds.
 */

test("an under-counting provider input still marks over-budget from the assembled estimate", () => {
  const controller = new CompactionController(undefined);
  // Provider reports 141k (well under 0.8*262144 = 209715), but the assembled history estimates 412k.
  controller.noteUsage(141_000, 262_144, 412_000);
  assert.equal(controller.needed(true), true);
});

test("an agreeing provider input and estimate behave exactly as before (under budget)", () => {
  const controller = new CompactionController(undefined);
  // Both numbers agree and sit under 0.8*window, so nothing folds - the regression guard.
  controller.noteUsage(120_000, 262_144, 120_000);
  assert.equal(controller.needed(true), false);
});

test("the estimate never lowers the budget below the provider input", () => {
  const controller = new CompactionController(undefined);
  // A stale/empty estimate must not mask a provider input that is itself over budget.
  controller.noteUsage(220_000, 262_144, 0);
  assert.equal(controller.needed(true), true);
});

test("noteTurnCompleted carries the assembled estimate into the trigger", () => {
  const controller = new CompactionController(undefined);
  controller.noteTurnCompleted({ input: 141_000, contextWindow: 262_144 }, 412_000);
  assert.equal(controller.needed(true), true);
  assert.deepEqual(controller.usageSeed(), { input: 412_000, contextWindow: 262_144 });
});

/**
 * 03.2 M4: the trigger budgets against the window that will REPLAY the shared history - the
 * foreground / session-minimum window - never a larger transient (e.g. a 1M-window delegate/sub) turn.
 * A genuine foreground-model change still re-anchors the window, so a real upgrade is honored.
 */

test("a larger interleaved window does not suppress a fold the foreground window needs", () => {
  const controller = new CompactionController(undefined);
  controller.noteProvider(fakeProvider("minimax", "MiniMax-M3"));
  controller.noteUsage(220_000, 262_144, 220_000);
  assert.equal(controller.needed(true), true);
  // A 1M-window turn arrives carrying the SAME shared history; today it would reset the trigger
  // (0.8*1M = 800k) and the fold would never run.
  controller.noteUsage(220_000, 1_000_000, 220_000);
  assert.equal(controller.needed(true), true);
});

test("a genuine foreground upgrade to a larger window is honored once it is the foreground", () => {
  const controller = new CompactionController(undefined);
  controller.noteProvider(fakeProvider("minimax", "MiniMax-M3"));
  controller.noteUsage(220_000, 262_144, 220_000);
  assert.equal(controller.needed(true), true);
  // The foreground model itself changes to a larger-window model: re-anchor and honor its window.
  controller.noteProvider(fakeProvider("big", "Big-1M"));
  controller.noteUsage(220_000, 1_000_000, 220_000);
  assert.equal(controller.needed(true), false);
});

test("the retained replay window keeps a growing history foldable across interleaved turns", () => {
  const controller = new CompactionController(undefined);
  controller.noteProvider(fakeProvider("minimax", "MiniMax-M3"));
  controller.noteUsage(180_000, 262_144, 180_000);
  // Interleaved 1M-window turns between foreground turns must not lift the budget window off 262144.
  controller.noteUsage(180_000, 1_000_000, 180_000);
  controller.noteUsage(215_000, 262_144, 215_000);
  controller.noteUsage(215_000, 1_000_000, 215_000);
  assert.equal(controller.needed(true), true);
});
