import assert from "node:assert/strict";
import { SUPERVISOR_SESSION_ID, events as sessionEvents } from "@belay/session";
import { recordingTransport, storedEvent } from "@belay/test-kit";
import { act, renderHook } from "@testing-library/react";
import { afterEach, test, vi } from "vitest";
import { TAIL_FLUSH_MS } from "@/session/use-session";
import { useSidebarSupervisor } from "./use-sidebar-supervisor";

/**
 * The sidebar's projects.list fold: the wire projects map to ProjectSidebarRecord with the DURABLE
 * registry metadata when the supervisor reports it - createdAt is the sidebar's stable ordering
 * key, so it must never be fabricated from updatedAt (that made projects re-order whenever a
 * launch touched their record) - and with derived stand-ins for a legacy supervisor that omits it.
 */

afterEach(() => {
  vi.useRealTimers();
});

function renderSupervisor() {
  const rec = recordingTransport();
  const view = renderHook(() => useSidebarSupervisor({ active: true, transport: rec.transport }));
  return { rec, ...view };
}

/** The requestId of the hook's own projects.list.requested publish (minted with a random UUID). */
const listRequestId = (rec: ReturnType<typeof recordingTransport>): string =>
  rec.publishedBy(SUPERVISOR_SESSION_ID).find((p) => p.type === "projects.list.requested")?.payload
    .requestId as string;

function deliverList(
  rec: ReturnType<typeof recordingTransport>,
  projects: Parameters<typeof sessionEvents.projectsListResult>[0]["projects"],
): void {
  const connect = rec.connects.find((c) => c.sessionId === SUPERVISOR_SESSION_ID);
  connect?.onEvent(
    storedEvent(sessionEvents.projectsListResult({ requestId: listRequestId(rec), projects }), {
      sessionId: SUPERVISOR_SESSION_ID,
      seq: 1,
      producerId: "supervisor",
    }),
  );
}

test("registry metadata maps through verbatim - createdAt stays the durable value, never updatedAt", async () => {
  vi.useFakeTimers();
  const { rec, result } = renderSupervisor();
  await act(async () => {});

  act(() => {
    deliverList(rec, [
      {
        root: "/Users/me/dotfiles",
        sessionId: "sess-dot",
        updatedAt: "2026-07-10T16:20:34.249Z",
        missing: false,
        displayPath: "~/dev/dotfiles",
        displayName: "my dotfiles",
        collapsed: true,
        createdAt: "2026-07-08T06:01:55.483Z",
      },
    ]);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(TAIL_FLUSH_MS);
  });

  assert.deepEqual(result.current.projects, [
    {
      path: "/Users/me/dotfiles",
      displayPath: "~/dev/dotfiles",
      displayName: "my dotfiles",
      collapsed: true,
      createdAt: "2026-07-08T06:01:55.483Z",
      updatedAt: "2026-07-10T16:20:34.249Z",
      missing: false,
    },
  ]);
});

test("a legacy result without registry metadata falls back to derived stand-ins", async () => {
  vi.useFakeTimers();
  const { rec, result } = renderSupervisor();
  await act(async () => {});

  act(() => {
    deliverList(rec, [
      { root: "/work/app", sessionId: "sess-app", updatedAt: "2026-07-09T10:00:00.000Z" },
    ]);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(TAIL_FLUSH_MS);
  });

  assert.deepEqual(result.current.projects, [
    {
      path: "/work/app",
      displayPath: "/work/app",
      displayName: "app",
      collapsed: false,
      createdAt: "2026-07-09T10:00:00.000Z",
      updatedAt: "2026-07-09T10:00:00.000Z",
      missing: false,
    },
  ]);
});
