import assert from "node:assert/strict";
import type { EmitEvent } from "@host/transport/services";
import { events, type TrevorEventInput } from "@trevor/session";
import { describe, test } from "vitest";
import { makeSessionSwitch, type SessionSwitchDeps, type WorkspaceTarget } from "./session-switch";

/**
 * Plan 58.2 M1: `/worktree-*` switches must stamp `session.project` on the TARGET session with the
 * base repo BEFORE the replacement host spawns, so inventory groups the worktree under its base
 * project rather than the worktree path. These tests pin the call order and the fail-before-spawn
 * path when base-repo resolution fails.
 */

type Call = { readonly name: string; readonly detail?: unknown };

function recordingDeps(
  over: Partial<SessionSwitchDeps> & {
    readonly calls: Call[];
  },
): SessionSwitchDeps {
  const { calls } = over;
  const emit: EmitEvent = async (event) => {
    calls.push({ name: "emit", detail: event });
  };
  return {
    sessionId: "source-session",
    transport: {
      ensureSession: async (sessionId) => {
        calls.push({ name: "ensureSession", detail: sessionId });
        return sessionId;
      },
    },
    emit,
    scheduler: {
      isBusy: () => false,
      debug: () => ({ active: null, queued: 0, lastAnswerSeq: -1, compacting: false }),
      clearPending: () => calls.push({ name: "clearPending" }),
    },
    turnMachine: { hasInFlight: false },
    manualCompactFiber: () => null,
    backgroundChildren: new Map(),
    debugMode: () => false,
    baseRepoFor: (cwd) => {
      calls.push({ name: "baseRepoFor", detail: cwd });
      return "/dev/trevor";
    },
    publishToSession: async (sessionId, event) => {
      calls.push({ name: "publishToSession", detail: { sessionId, event } });
    },
    spawnReplacementHost: (opts) => {
      calls.push({ name: "spawnReplacementHost", detail: opts });
      return { pid: 4242 };
    },
    ...over,
  };
}

const TARGET: WorkspaceTarget = {
  cwd: "/Users/kevin/dev/.worktrees/trevor/feat-x-abc",
  sessionId: "worktree-session",
  workspace: "/Users/kevin/dev/.worktrees/trevor/feat-x-abc",
};

describe("switchToWorkspace worktree stamping (plan 58.2 M1)", () => {
  test("reason=worktree: ensureSession -> publish session.project(baseRepo) -> spawn -> session.switch", async () => {
    const calls: Call[] = [];
    const api = makeSessionSwitch(recordingDeps({ calls }));

    await api.switchToWorkspace({ ...TARGET, reason: "worktree" });

    const names = calls.map((c) => c.name);
    // Order-sensitive: the durable marker must land on the TARGET before the host spawns.
    assert.deepEqual(names.slice(0, 4), [
      "ensureSession",
      "baseRepoFor",
      "publishToSession",
      "spawnReplacementHost",
    ]);
    // session.switch rides the current session's emit after spawn.
    assert.ok(names.includes("emit"), "session.switch must be emitted on the source session");
    const emitIdx = names.indexOf("emit");
    const spawnIdx = names.indexOf("spawnReplacementHost");
    assert.ok(spawnIdx < emitIdx, "spawn must precede session.switch emit");

    assert.equal(calls[0]?.detail, TARGET.sessionId);

    const publish = calls.find((c) => c.name === "publishToSession");
    assert.ok(publish);
    assert.deepEqual(publish?.detail, {
      sessionId: TARGET.sessionId,
      event: events.sessionProject({ path: "/dev/trevor" }),
    });

    const spawn = calls.find((c) => c.name === "spawnReplacementHost");
    assert.deepEqual(spawn?.detail, {
      cwd: TARGET.cwd,
      sessionId: TARGET.sessionId,
      workspace: TARGET.workspace,
    });

    const switchEvent = calls.find((c) => c.name === "emit")?.detail as
      | TrevorEventInput
      | undefined;
    assert.equal(switchEvent?.type, "session.switch");
    const switchPayload = (
      switchEvent as { payload?: { sessionId?: string; reason?: string } } | undefined
    )?.payload;
    assert.equal(switchPayload?.sessionId, TARGET.sessionId);
    assert.equal(switchPayload?.reason, "worktree");
  });

  test("reason=worktree with no baseRepoFor(cwd): fails before spawn and does not emit session.switch", async () => {
    const calls: Call[] = [];
    const api = makeSessionSwitch(
      recordingDeps({
        calls,
        baseRepoFor: (cwd) => {
          calls.push({ name: "baseRepoFor", detail: cwd });
          return null;
        },
      }),
    );

    await assert.rejects(
      () => api.switchToWorkspace({ ...TARGET, reason: "worktree" }),
      /base repo/i,
    );

    const names = calls.map((c) => c.name);
    assert.ok(names.includes("ensureSession"));
    assert.ok(names.includes("baseRepoFor"));
    assert.ok(!names.includes("spawnReplacementHost"), "must not spawn without a base repo");
    assert.ok(!names.includes("publishToSession"), "must not publish without a base repo");
    assert.ok(!names.includes("emit"), "must not emit session.switch after a failed stamp");
  });

  test("reason=cd: does not stamp session.project (no baseRepoFor, no publishToSession)", async () => {
    const calls: Call[] = [];
    const api = makeSessionSwitch(recordingDeps({ calls }));

    await api.switchToWorkspace({
      cwd: "/dev/other",
      sessionId: "cd-session",
      workspace: "/dev/other",
      reason: "cd",
    });

    const names = calls.map((c) => c.name);
    assert.ok(!names.includes("baseRepoFor"));
    assert.ok(!names.includes("publishToSession"));
    assert.ok(names.includes("ensureSession"));
    assert.ok(names.includes("spawnReplacementHost"));
    assert.ok(names.includes("emit"));
  });
});

describe("createWorktreeSession concurrent path (plan 58.7 M1)", () => {
  test("ensures target, stamps base repo, spawns target host, and leaves source host alive", async () => {
    const calls: Call[] = [];
    const api = makeSessionSwitch(recordingDeps({ calls }));

    await api.createWorktreeSession(TARGET);

    const names = calls.map((c) => c.name);
    assert.deepEqual(names, [
      "ensureSession",
      "baseRepoFor",
      "publishToSession",
      "spawnReplacementHost",
    ]);
    assert.ok(!names.includes("emit"), "concurrent create must not emit session.switch");
    assert.ok(!names.includes("clearPending"), "source scheduler queue must stay intact");

    const publish = calls.find((c) => c.name === "publishToSession");
    assert.deepEqual(publish?.detail, {
      sessionId: TARGET.sessionId,
      event: events.sessionProject({ path: "/dev/trevor" }),
    });
  });

  test("stamps session.worktree when the target carries worktree identity (plan 58.7)", async () => {
    const calls: Call[] = [];
    const api = makeSessionSwitch(recordingDeps({ calls }));

    await api.createWorktreeSession({
      ...TARGET,
      worktree: { id: "wt-1", branch: "feat/x", path: TARGET.cwd },
    });

    const publishes = calls.filter((c) => c.name === "publishToSession");
    // Two markers: session.project (base repo) then session.worktree (identity).
    assert.equal(publishes.length, 2);
    assert.deepEqual(publishes[0]?.detail, {
      sessionId: TARGET.sessionId,
      event: events.sessionProject({ path: "/dev/trevor" }),
    });
    assert.deepEqual(publishes[1]?.detail, {
      sessionId: TARGET.sessionId,
      event: events.sessionWorktree({ id: "wt-1", branch: "feat/x", path: TARGET.cwd }),
    });
  });

  test("does not stamp session.worktree without worktree identity (backward compat)", async () => {
    const calls: Call[] = [];
    const api = makeSessionSwitch(recordingDeps({ calls }));

    await api.createWorktreeSession(TARGET);

    const publishes = calls.filter((c) => c.name === "publishToSession");
    assert.equal(publishes.length, 1);
    const firstPublish = publishes[0]?.detail as { event: TrevorEventInput } | undefined;
    assert.equal(firstPublish?.event.type, "session.project");
  });

  test("fails before spawning when the base repo cannot be resolved", async () => {
    const calls: Call[] = [];
    const api = makeSessionSwitch(
      recordingDeps({
        calls,
        baseRepoFor: (cwd) => {
          calls.push({ name: "baseRepoFor", detail: cwd });
          return null;
        },
      }),
    );

    await assert.rejects(() => api.createWorktreeSession(TARGET), /base repo/i);

    const names = calls.map((c) => c.name);
    assert.ok(names.includes("ensureSession"));
    assert.ok(names.includes("baseRepoFor"));
    assert.ok(!names.includes("publishToSession"));
    assert.ok(!names.includes("spawnReplacementHost"));
    assert.ok(!names.includes("emit"));
  });
});
