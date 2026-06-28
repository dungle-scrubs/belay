import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import {
  events,
  type SessionEvent,
  type SessionSummary,
  type TrevorEventInput,
  type WorktreeSummary,
} from "@trevor/session";
import { beforeEach, test, vi } from "vitest";
import type { HostStatus } from "../derive";
import { useModalState } from "./use-modal-state";

const mockInventory = vi.hoisted(() => ({
  enabledCalls: [] as boolean[],
  state: {
    sessions: [] as readonly SessionSummary[],
    loading: false,
    error: null as string | null,
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
  project: "trevorV2",
  branch: null,
  git: null,
  createdAt: "2026-06-28T00:00:00.000Z",
  updatedAt: "2026-06-28T00:00:00.000Z",
  eventCount: 1,
  host: "live",
  activity: "settled",
  archived: false,
  deleted: false,
  ...over,
});

const worktree: WorktreeSummary = {
  id: "wt-feature",
  baseRepo: "/Users/kevin/dev/trevorV2",
  baseRepoName: "trevorV2",
  branch: "feature/modal-state",
  path: "~/.trevorV2/.worktrees/feature-modal-state",
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

const stored = (input: TrevorEventInput): SessionEvent => ({
  sessionId: "s-current",
  seq: 1,
  eventId: "ev-1",
  producerId: "host",
  createdAt: "2026-06-28T00:00:00.000Z",
  type: input.type,
  payload: input.payload,
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

  const { result, rerender } = renderHook(
    ({ sessions }) => {
      mockInventory.state.sessions = sessions;
      return useModalState({
        events: eventsLog,
        host,
        target: "s-current",
        sessionId: "s-current",
        busy: true,
      });
    },
    { initialProps: { sessions: mockInventory.state.sessions } },
  );

  assert.deepEqual(mockInventory.enabledCalls, [false]);
  assert.equal(result.current.currentProject, "trevorV2");
  assert.deepEqual(result.current.worktrees, [worktree]);
  assert.deepEqual(result.current.worktreeActivity.get("s-worktree"), {
    host: "stale",
    activity: "running",
  });
  assert.equal(result.current.sidebarLiveActivity.get("s-current"), "running");

  act(() => result.current.setSidebarOpen(true));
  assert.equal(mockInventory.enabledCalls.at(-1), true);

  rerender({ sessions: [] });
  assert.equal(result.current.currentProject, "trevorV2");
});
