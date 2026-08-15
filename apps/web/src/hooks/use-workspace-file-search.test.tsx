import type { SessionEvent } from "@belay/session";
import * as sessionModule from "@belay/session";
import { events } from "@belay/session";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  fileIndexFrom,
  useFileIndex,
  useWorkspaceFileSearch,
  type WorkspaceFileIndex,
} from "./use-workspace-file-search";

// Partial mock: keep every real export (events builders, decodeTrevorEvent, ...) but wrap
// searchWorkspaceFiles in a spy so a regression test can assert its CALL COUNT (not just its output)
// without depending on whether the workspace-package's live bindings are spy-able as plain ESM exports.
vi.mock("@belay/session", async (importOriginal) => {
  const actual = await importOriginal<typeof sessionModule>();
  return { ...actual, searchWorkspaceFiles: vi.fn(actual.searchWorkspaceFiles) };
});

function stored(input: ReturnType<typeof events.fileIndexResult>, seq: number): SessionEvent {
  return {
    sessionId: "s",
    seq,
    eventId: `ev-${seq}`,
    producerId: "host",
    createdAt: "2026-01-01T00:00:00.000Z",
    type: input.type,
    payload: input.payload as Record<string, unknown>,
  };
}

describe("fileIndexFrom", () => {
  test("returns a not-ready empty index until the host answers", () => {
    expect(fileIndexFrom([])).toEqual({ files: [], truncated: false, ready: false });
  });

  test("takes the LATEST file.index.result, so a newer answer supersedes a stale one", () => {
    const older = stored(
      events.fileIndexResult({ requestId: "r1", files: [{ path: "old.ts" }], truncated: false }),
      1,
    );
    const newer = stored(
      events.fileIndexResult({ requestId: "r2", files: [{ path: "new.ts" }], truncated: true }),
      2,
    );
    const index = fileIndexFrom([older, newer]);
    expect(index.files.map((f) => f.path)).toEqual(["new.ts"]);
    expect(index.truncated).toBe(true);
    expect(index.ready).toBe(true);
  });
});

describe("useWorkspaceFileSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const INDEX: WorkspaceFileIndex = {
    files: [{ path: "a.ts" }, { path: "ab.ts" }, { path: "b.ts" }],
    truncated: false,
    ready: true,
  };

  test("a null query yields no results", () => {
    const { result } = renderHook(() => useWorkspaceFileSearch(null, INDEX));
    expect(result.current.results).toEqual([]);
  });

  test("debounces, and results reflect only the latest query (no stale overwrite)", () => {
    const { result, rerender } = renderHook(({ q }) => useWorkspaceFileSearch(q, INDEX), {
      initialProps: { q: "a" },
    });
    // Before the debounce settles, change to a narrower query.
    rerender({ q: "ab" });
    act(() => vi.advanceTimersByTime(100));
    // Only "ab" matches ab.ts; the intermediate "a" (which would also include a.ts) never committed.
    expect(result.current.results.map((f) => f.path)).toEqual(["ab.ts"]);
  });

  test("reports truncation when the host index was capped", () => {
    const capped: WorkspaceFileIndex = { ...INDEX, truncated: true };
    const { result } = renderHook(() => useWorkspaceFileSearch("a", capped));
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.truncated).toBe(true);
  });

  test("the debounce is NOT defeated: rapid keystrokes trigger one search, not one per keystroke", () => {
    const spy = vi.mocked(sessionModule.searchWorkspaceFiles);
    const { rerender } = renderHook(({ q }) => useWorkspaceFileSearch(q, INDEX), {
      initialProps: { q: "a" },
    });
    const afterMount = spy.mock.calls.length;
    // Three more keystrokes land before the debounce window elapses - none of them may re-invoke the
    // (expensive) search; only the settled query is allowed to trigger a recomputation.
    rerender({ q: "ab" });
    rerender({ q: "abc" });
    rerender({ q: "abcd" });
    expect(spy.mock.calls.length).toBe(afterMount);

    act(() => vi.advanceTimersByTime(100));
    // Exactly one more call once the debounce settles - not one per keystroke.
    expect(spy.mock.calls.length).toBe(afterMount + 1);
  });
});

describe("useFileIndex", () => {
  test("returns the SAME object reference across renders when only UNRELATED events changed", () => {
    const resultEvent = stored(
      events.fileIndexResult({ requestId: "r1", files: [{ path: "a.ts" }], truncated: false }),
      1,
    );
    const unrelated = stored(events.userCommand({ command: "/doctor", args: "" }), 2);
    const { result, rerender } = renderHook(({ evts }) => useFileIndex(evts), {
      initialProps: { evts: [resultEvent] as SessionEvent[] },
    });
    const first = result.current;

    // A brand-new `events` array identity, but no NEW file.index.result inside it.
    rerender({ evts: [resultEvent, unrelated] });

    expect(result.current).toBe(first);
  });

  test("returns a NEW object once a newer file.index.result actually arrives", () => {
    const first = stored(
      events.fileIndexResult({ requestId: "r1", files: [{ path: "a.ts" }], truncated: false }),
      1,
    );
    const second = stored(
      events.fileIndexResult({ requestId: "r2", files: [{ path: "b.ts" }], truncated: false }),
      2,
    );
    const { result, rerender } = renderHook(({ evts }) => useFileIndex(evts), {
      initialProps: { evts: [first] as SessionEvent[] },
    });
    const before = result.current;

    rerender({ evts: [first, second] });

    expect(result.current).not.toBe(before);
    expect(result.current.files.map((f) => f.path)).toEqual(["b.ts"]);
  });

  test("stays stable (EMPTY_INDEX) across renders before any index has ever arrived", () => {
    const unrelated1 = stored(events.userCommand({ command: "/doctor", args: "" }), 1);
    const unrelated2 = stored(events.userCommand({ command: "/help", args: "" }), 2);
    const { result, rerender } = renderHook(({ evts }) => useFileIndex(evts), {
      initialProps: { evts: [unrelated1] as SessionEvent[] },
    });
    const first = result.current;

    rerender({ evts: [unrelated1, unrelated2] });

    expect(result.current).toBe(first);
    expect(result.current.ready).toBe(false);
  });
});
