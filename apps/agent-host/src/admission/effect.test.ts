import assert from "node:assert/strict";
import { Effect, Stream } from "effect";
import { test } from "vitest";
import { admittedStream, releaseReason } from "./effect";
import type { AdmissionHandle } from "./runtime";

/**
 * The admission Effect bridge (plan 11 M5/M6): proves the generation lease is acquired before the
 * stream emits and released exactly once on completion / failure / interruption, hermetically with a
 * fake handle and a trivial Stream (no LM Studio, no real lease).
 */

function fakeHandle(log: string[]): AdmissionHandle {
  return {
    held: true,
    ownerId: "owner",
    release: async (reason) => {
      log.push(`release:${reason}`);
    },
  };
}

test("acquires before the stream emits and releases success on completion", async () => {
  const log: string[] = [];
  const stream = admittedStream(
    Effect.promise(async () => {
      log.push("acquire");
      return fakeHandle(log);
    }),
    () =>
      Stream.fromIterable([1, 2, 3]).pipe(Stream.tap(() => Effect.sync(() => log.push("emit")))),
  );
  const out = await Effect.runPromise(Stream.runCollect(stream));
  assert.deepEqual([...out], [1, 2, 3]);
  assert.equal(log[0], "acquire", "the lease is acquired first");
  assert.ok(log.indexOf("acquire") < log.indexOf("emit"), "acquire precedes any emit");
  assert.equal(log.at(-1), "release:success", "the lease is released once, with success");
  assert.equal(log.filter((l) => l.startsWith("release")).length, 1, "released exactly once");
});

test("releases with provider_failure when the stream fails", async () => {
  const log: string[] = [];
  const stream = admittedStream(
    Effect.promise(async () => fakeHandle(log)),
    () => Stream.fail("boom" as const),
  );
  const exit = await Effect.runPromiseExit(Stream.runDrain(stream));
  assert.equal(exit._tag, "Failure");
  assert.equal(log.at(-1), "release:provider_failure");
});

test("releases with cancelled when the stream scope is interrupted", async () => {
  const log: string[] = [];
  const stream = admittedStream(
    Effect.promise(async () => fakeHandle(log)),
    // A never-ending stream so the fiber is still running when we interrupt it.
    () => Stream.never,
  );
  const fiber = Effect.runFork(Stream.runDrain(stream));
  // Let the acquire + stream start, then interrupt.
  await new Promise((r) => setTimeout(r, 10));
  await Effect.runPromise(fiber.interruptAsFork(fiber.id()));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(log.at(-1), "release:cancelled", "interruption releases as cancelled");
});

test("interrupting the fiber while acquire is still WAITING aborts the acquire signal (cancel works)", async () => {
  // The acquire models a turn parked in the admission queue: it resolves only when its signal aborts.
  // With an uninterruptible acquire (the acquireRelease default) the signal would never fire here and a
  // cancel would hang until the slot was won; the uninterruptibleMask+restore makes acquire interruptible
  // so the cancel aborts the wait at once.
  let abortSeen = false;
  const stream = admittedStream(
    Effect.promise(
      (signal) =>
        new Promise<AdmissionHandle>((resolve) => {
          signal.addEventListener("abort", () => {
            abortSeen = true;
            resolve({ held: false, ownerId: null, release: async () => {} });
          });
        }),
    ),
    () => Stream.never,
  );
  const fiber = Effect.runFork(Stream.runDrain(stream));
  await new Promise((r) => setTimeout(r, 10)); // let the acquire start waiting
  await Effect.runPromise(fiber.interruptAsFork(fiber.id()));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(abortSeen, true, "interruption aborted the still-waiting acquire's signal");
});

test("releaseReason maps exits", async () => {
  const ok = await Effect.runPromiseExit(Effect.succeed(1));
  assert.equal(releaseReason(ok), "success");
  const fail = await Effect.runPromiseExit(Effect.fail("x"));
  assert.equal(releaseReason(fail), "provider_failure");
});
