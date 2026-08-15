import assert from "node:assert/strict";
import { test } from "vitest";
import { makeCommandFileDispatch } from "./command-file-dispatch";
import type { LoadedCommandFile } from "./command-loader";
import { resolveInterpolationConfig } from "./interpolation";

/**
 * The expand-on-dispatch SUBMIT branch (plan 44.5 M4): a file-loaded command SUBMITS its expanded body
 * as the turn's prompt (a user.message via the control-prompt seam), not a command.result. Verifies the
 * interpolate-then-substitute ordering (D-007), verbatim `$ARGUMENTS` threading, and fail-soft.
 */

function file(
  over: Partial<LoadedCommandFile> & Pick<LoadedCommandFile, "id" | "body">,
): LoadedCommandFile {
  return { rootKind: "project", summary: "", ...over };
}

test("dispatching /fix 123 for `Fix issue #$0` publishes the expanded prompt", async () => {
  const published: string[] = [];
  const dispatch = makeCommandFileDispatch({
    interpolationConfig: resolveInterpolationConfig({}),
    publish: async (text) => {
      published.push(text);
    },
    emitResult: async () => {},
  });
  await dispatch.submit(file({ id: "/fix", body: "Fix issue #$0" }), "123");
  assert.deepEqual(published, ["Fix issue #123"]);
});

test("$ARGUMENTS receives the exact raw args string verbatim (D-002)", async () => {
  const published: string[] = [];
  const dispatch = makeCommandFileDispatch({
    interpolationConfig: resolveInterpolationConfig({}),
    publish: async (text) => {
      published.push(text);
    },
    emitResult: async () => {},
  });
  await dispatch.submit(file({ id: "/ctx", body: "Context: $ARGUMENTS" }), '"a b"  c');
  assert.deepEqual(published, ['Context: "a b"  c']);
});

test("interpolate-then-substitute (D-007): a $0 value containing !cmd lands inert even with interpolation ON", async () => {
  const published: string[] = [];
  const dispatch = makeCommandFileDispatch({
    // Gate OPEN, so if the ordering were reversed the substituted `!belay-export` would become an
    // interpolation site and run. It must not: interpolation runs on the trusted body FIRST.
    interpolationConfig: resolveInterpolationConfig({ TREVOR_ENABLE_INTERPOLATION: "1" }),
    publish: async (text) => {
      published.push(text);
    },
    emitResult: async () => {},
  });
  await dispatch.submit(file({ id: "/run", body: "Run $0 now" }), "!belay-export");
  assert.deepEqual(published, ["Run !belay-export now"]);
});

test("a dispatch failure is fail-soft: it emits an error command.result, never throws", async () => {
  const results: { command: string; text: string; ok: boolean }[] = [];
  const dispatch = makeCommandFileDispatch({
    interpolationConfig: resolveInterpolationConfig({}),
    publish: async () => {
      throw new Error("boom");
    },
    emitResult: async (r) => {
      results.push(r);
    },
  });
  await dispatch.submit(file({ id: "/x", body: "hi $0" }), "a");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.ok, false);
  assert.equal(results[0]?.command, "/x");
  assert.match(results[0]?.text ?? "", /boom/);
});
