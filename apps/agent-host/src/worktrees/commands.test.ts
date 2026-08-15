import assert from "node:assert/strict";
import { decodeTrevorEvent, type TrevorEventInput } from "@belay/session";
import type { EmitEvent } from "@host/transport/services";
import { test } from "vitest";
import { makeWorktreeCommands } from "./commands";
import type { WorktreeManager } from "./manager";

test("/worktree-new creates a concurrent session and emits a focus command result", async () => {
  const emitted: TrevorEventInput[] = [];
  const concurrentTargets: unknown[] = [];
  const serialTargets: unknown[] = [];
  const emit: EmitEvent = async (event) => {
    emitted.push(event);
  };
  const worktrees = {
    createFromCwd: () => ({
      ok: true,
      record: {
        id: "wt-1",
        baseRepo: "/dev/belay",
        baseRepoName: "belay",
        worktreePath: "/dev/.worktrees/belay/feat-x",
        branch: "feat/x",
        baseCommit: "abc123",
        sessionId: "worktree-session",
        createdAt: "2026-07-09T00:00:00.000Z",
        updatedAt: "2026-07-09T00:00:00.000Z",
        status: "active",
      },
    }),
  } as unknown as WorktreeManager;

  const commands = makeWorktreeCommands({
    worktrees,
    cwdLockCaps: {
      fs: { readFile: () => null, writeFile: () => {}, remove: () => {} },
      now: () => 0,
      processAlive: () => false,
      realpath: (path) => path,
    },
    emit,
    blockedFromWorkspaceSwitch: async () => false,
    switchToWorkspace: async (target) => {
      serialTargets.push(target);
    },
    createWorktreeSession: async (target) => {
      concurrentTargets.push(target);
    },
    announceOnline: () => {},
  });

  await commands.worktreeNew("feat/x");

  assert.equal(serialTargets.length, 0, "/worktree-new must not use the serial switch path");
  assert.deepEqual(concurrentTargets, [
    {
      cwd: "/dev/.worktrees/belay/feat-x",
      sessionId: "worktree-session",
      workspace: "/dev/.worktrees/belay/feat-x",
      worktree: { id: "wt-1", branch: "feat/x", path: "/dev/.worktrees/belay/feat-x" },
    },
  ]);
  const result = emitted
    .map((event) =>
      decodeTrevorEvent({
        ...event,
        createdAt: "2026-07-09T00:00:00.000Z",
        eventId: "e",
        producerId: "belay-host",
        seq: 1,
        sessionId: "source-session",
      }),
    )
    .at(-1);
  assert.equal(result?.type, "command.result");
  if (result?.type !== "command.result") {
    return;
  }
  assert.equal(result.command, "/worktree-new");
  assert.equal(result.ok, true);
  assert.equal(result.focusSessionId, "worktree-session");
});
