import assert from "node:assert/strict";
import { test } from "vitest";
import { CompactionController } from "./compaction-controller";

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
