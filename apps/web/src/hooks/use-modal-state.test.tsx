import assert from "node:assert/strict";
import {
  events,
  type SessionEvent,
  type SessionSummary,
  type TrevorEventInput,
  type WorktreeSummary,
} from "@belay/session";
import { storedEvent } from "@belay/test-kit";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, test, vi } from "vitest";
import type { HostStatus } from "../derive";
import { hostAnnouncement, worktreesFrom } from "../derive";
import { useModalState } from "./use-modal-state";

const mockInventory = vi.hoisted(() => ({
  enabledCalls: [] as boolean[],
  state: {
    sessions: [] as readonly SessionSummary[],
    loading: false,
    error: null as string | null,
    refetch: () => {},
  },
}));

vi.mock("../resume", () => ({
  useInventory: (enabled: boolean) => {
    mockInventory.enabledCalls.push(enabled);
    return mockInventory.state;
  },
}));

const host: HostStatus = {
  branch: null,
  git: null,
  cwd: null,
  leaderId: null,
  present: false,
  standbyCount: 0,
  workspace: null,
};

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: "s-current",
  title: "Current",
  cwd: null,
  workspace: null,
  project: "belay",
  projectPath: null,
  branch: null,
  git: null,
  createdAt: "2026-06-28T00:00:00.000Z",
  updatedAt: "2026-06-28T00:00:00.000Z",
  eventCount: 1,
  host: "live",
  activity: "settled",
  archived: false,
  deleted: false,
  forkedFrom: null,
  tangentOf: null,
  worktree: null,
  ...over,
});

const worktree: WorktreeSummary = {
  id: "wt-feature",
  baseRepo: "/Users/kevin/dev/belay",
  baseRepoName: "belay",
  branch: "feature/modal-state",
  path: "~/.belay/.worktrees/feature-modal-state",
  sessionId: "s-worktree",
  dirty: false,
  ahead: 0,
  behind: 0,
  conflict: false,
  detached: false,
  current: false,
  baseline: false,
  missing: false,
};

const stored = (input: TrevorEventInput): SessionEvent =>
  storedEvent(input, {
    sessionId: "s-current",
    eventId: "ev-1",
    producerId: "host",
    createdAt: "2026-06-28T00:00:00.000Z",
  });

beforeEach(() => {
  localStorage.clear();
  mockInventory.enabledCalls.length = 0;
  mockInventory.state.sessions = [];
  mockInventory.state.loading = false;
  mockInventory.state.error = null;
});

test("owns modal toggles, inventory gating, project stickiness, and activity overlays", () => {
  mockInventory.state.sessions = [
    session(),
    session({ sessionId: "s-worktree", title: "Worktree", host: "stale", activity: "running" }),
  ];
  const eventsLog = [
    stored(
      events.hostOnline({
        providers: ["qwen"],
        default: "qwen",
        models: {},
        instanceId: "host-1",
        cwd: "~",
        workspace: "~",
        commands: [],
        agents: [],
        worktrees: [worktree],
      }),
    ),
  ];
  const worktrees = worktreesFrom(hostAnnouncement(eventsLog));

  const { result, rerender } = renderHook(
    ({ sessions }) => {
      mockInventory.state.sessions = sessions;
      return useModalState({
        worktrees,
        host,
        target: "s-current",
        sessionId: "s-current",
        busy: true,
      });
    },
    { initialProps: { sessions: mockInventory.state.sessions } },
  );

  // The project sidebar (plan 58) defaults open, so the inventory fetch is enabled on first render.
  assert.deepEqual(mockInventory.enabledCalls, [true]);
  assert.equal(result.current.currentProject, "belay");
  assert.deepEqual(result.current.worktrees, [worktree]);
  assert.deepEqual(result.current.worktreeActivity.get("s-worktree"), {
    host: "stale",
    activity: "running",
  });
  assert.equal(result.current.sidebarLiveActivity.get("s-current"), "running");

  act(() => result.current.setSidebarOpen(true));
  assert.equal(mockInventory.enabledCalls.at(-1), true);

  rerender({ sessions: [] });
  assert.equal(result.current.currentProject, "belay");
});

test("opening the archive browser enables the inventory fetch", () => {
  const { result } = renderHook(() =>
    useModalState({ worktrees: [], host, target: "s", sessionId: "s", busy: false }),
  );
  assert.equal(result.current.archiveOpen, false);
  // The sidebar defaults open (plan 58), so the inventory is already enabled.
  assert.equal(mockInventory.enabledCalls.at(-1), true);

  act(() => result.current.setArchiveOpen(true));
  assert.equal(result.current.archiveOpen, true);
  assert.equal(mockInventory.enabledCalls.at(-1), true);
});
