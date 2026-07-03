import { act, renderHook } from "@testing-library/react";
import type { SessionEvent } from "@trevor/session";
import { events } from "@trevor/session";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  fileIndexFrom,
  useWorkspaceFileSearch,
  type WorkspaceFileIndex,
} from "./use-workspace-file-search";

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
});
