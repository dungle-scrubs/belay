import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEvent } from "./event";
import { type InventoryRow, sessionProjectPath, summarizeSession } from "./inventory";
import { events, type TrevorEventInput } from "./protocol";

/**
 * The canonical project-path selection (plan 58 M3): the durable `session.project` marker wins over
 * host.online workspace/cwd, so the inventory can group sessions by project without relying on a live
 * host. Pins the pure helper and the summarizeSession projection that consumes it.
 */

/** Wrap an emit-side input into a full stored SessionEvent (what decodeTrevorEvent reads). */
const stored = (input: TrevorEventInput, over: Partial<SessionEvent> = {}): SessionEvent => ({
  sessionId: "s",
  seq: 1,
  eventId: "ev-1",
  producerId: "host",
  createdAt: "2026-01-01T00:00:00.000Z",
  type: input.type,
  payload: input.payload as Record<string, unknown>,
  ...over,
});

const HOST_ONLINE = (over: { cwd?: string; workspace?: string } = {}): SessionEvent =>
  stored(
    events.hostOnline({
      providers: ["lmstudio"],
      default: "lmstudio",
      models: {},
      instanceId: "host",
      cwd: over.cwd ?? "/tmp/repo",
      workspace: over.workspace ?? "/tmp/repo",
      commands: [],
      agents: [],
    }),
  );

/** A minimal InventoryRow with every field defaulted except the overrides given. */
function row(over: Partial<InventoryRow> = {}): InventoryRow {
  return {
    sessionId: "s",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    eventCount: 1,
    hostOnline: null,
    firstUser: null,
    lifecycle: [],
    archived: null,
    rename: null,
    deleted: null,
    forkedFrom: null,
    tangentOf: null,
    projectMarker: null,
    hostPresent: false,
    ...over,
  };
}

test("sessionProjectPath returns the marker path when present, ignoring workspace/cwd", () => {
  const marker = stored(events.sessionProject({ path: "/Users/kevin/dev/trevor" }));
  assert.equal(sessionProjectPath(marker, "/tmp/other", "/tmp/cwd"), "/Users/kevin/dev/trevor");
});

test("sessionProjectPath falls back to workspace when no marker", () => {
  assert.equal(sessionProjectPath(null, "/tmp/workspace", "/tmp/cwd"), "/tmp/workspace");
});

test("sessionProjectPath falls back to cwd when no marker and no workspace", () => {
  assert.equal(sessionProjectPath(null, null, "/tmp/cwd"), "/tmp/cwd");
});

test("sessionProjectPath returns null when none available", () => {
  assert.equal(sessionProjectPath(null, null, null), null);
});

test("summarizeSession includes projectPath from the marker when present", () => {
  const marker = stored(events.sessionProject({ path: "/Users/kevin/dev/trevor" }));
  const summary = summarizeSession(
    row({
      projectMarker: marker,
      hostOnline: HOST_ONLINE({ cwd: "/tmp/other", workspace: "/tmp/other" }),
    }),
  );
  assert.equal(summary.projectPath, "/Users/kevin/dev/trevor");
  // The legacy basename field still derives from workspace/cwd, not the marker.
  assert.equal(summary.project, "other");
});

test("summarizeSession falls back to workspace for projectPath when no marker", () => {
  const summary = summarizeSession(
    row({ hostOnline: HOST_ONLINE({ workspace: "/tmp/repo", cwd: "/tmp/repo/sub" }) }),
  );
  assert.equal(summary.projectPath, "/tmp/repo");
});

test("a legacy session (no marker, old host.online workspace) groups via projectPath", () => {
  const summary = summarizeSession(
    row({ hostOnline: HOST_ONLINE({ workspace: "/Users/kevin/dev/legacy" }) }),
  );
  assert.equal(summary.projectPath, "/Users/kevin/dev/legacy");
  assert.equal(summary.project, "legacy");
});
