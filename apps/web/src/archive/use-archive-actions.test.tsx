import assert from "node:assert/strict";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PermanentDeleteResult } from "@trevor/session";
import { test } from "vitest";
import { useArchiveActions } from "./use-archive-actions";

function harness(over?: {
  unarchive?: (id: string) => Promise<void>;
  remove?: (id: string) => Promise<PermanentDeleteResult>;
}) {
  const calls = { unarchived: [] as string[], removed: [] as string[], refreshed: 0 };
  const deps = {
    unarchive:
      over?.unarchive ??
      ((id: string) => {
        calls.unarchived.push(id);
        return Promise.resolve();
      }),
    remove:
      over?.remove ??
      ((id: string): Promise<PermanentDeleteResult> => {
        calls.removed.push(id);
        return Promise.resolve({ ok: true, sessionId: id });
      }),
    refresh: () => {
      calls.refreshed++;
    },
  };
  const hook = renderHook(() => useArchiveActions(deps));
  return { hook, calls };
}

test("unarchive marks the row in-flight, then clears it and refreshes on success", async () => {
  const { hook, calls } = harness();

  act(() => hook.result.current.onUnarchive("a"));
  assert.deepEqual(hook.result.current.actionState.a, { kind: "unarchiving" });

  await waitFor(() => assert.equal(calls.refreshed, 1));
  assert.equal(hook.result.current.actionState.a, undefined);
  assert.deepEqual(calls.unarchived, ["a"]);
});

test("an unarchive transport error latches a row-scoped error and does not refresh", async () => {
  const { hook, calls } = harness({
    unarchive: () => Promise.reject(new Error("network down")),
  });

  act(() => hook.result.current.onUnarchive("a"));
  await waitFor(() => assert.equal(hook.result.current.actionState.a?.kind, "error"));
  assert.deepEqual(hook.result.current.actionState.a, { kind: "error", message: "network down" });
  assert.equal(calls.refreshed, 0);
});

test("a successful permanent delete clears the row and refreshes", async () => {
  const { hook, calls } = harness();

  act(() => hook.result.current.onDelete("doomed"));
  assert.deepEqual(hook.result.current.actionState.doomed, { kind: "deleting" });

  await waitFor(() => assert.equal(calls.refreshed, 1));
  assert.equal(hook.result.current.actionState.doomed, undefined);
  assert.deepEqual(calls.removed, ["doomed"]);
});

test("a store rejection shows its detail as the row error and does not refresh", async () => {
  const { hook, calls } = harness({
    remove: () =>
      Promise.resolve({ ok: false, reason: "protected", detail: "a host is live on this session" }),
  });

  act(() => hook.result.current.onDelete("x"));
  await waitFor(() => assert.equal(hook.result.current.actionState.x?.kind, "error"));
  assert.deepEqual(hook.result.current.actionState.x, {
    kind: "error",
    message: "a host is live on this session",
  });
  assert.equal(calls.refreshed, 0);
});

test("a delete transport error falls back to a generic message", async () => {
  const { hook } = harness({ remove: () => Promise.reject("boom") });

  act(() => hook.result.current.onDelete("x"));
  await waitFor(() => assert.equal(hook.result.current.actionState.x?.kind, "error"));
  assert.deepEqual(hook.result.current.actionState.x, { kind: "error", message: "Delete failed." });
});

test("action state is row-scoped: one row's error never touches another row", async () => {
  const { hook } = harness({
    remove: (id) =>
      id === "bad"
        ? Promise.resolve({ ok: false, reason: "protected", detail: "blocked" })
        : Promise.resolve({ ok: true, sessionId: id }),
  });

  act(() => hook.result.current.onDelete("bad"));
  await waitFor(() => assert.equal(hook.result.current.actionState.bad?.kind, "error"));

  act(() => hook.result.current.onUnarchive("other"));
  // "bad" keeps its error; "other" carries its own in-flight state.
  assert.equal(hook.result.current.actionState.bad?.kind, "error");
  assert.deepEqual(hook.result.current.actionState.other, { kind: "unarchiving" });
});
