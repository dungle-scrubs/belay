import assert from "node:assert/strict";
import {
  decodeTrevorEvent,
  events,
  PRODUCER_IDS,
  type SessionConnection,
  SUPERVISOR_SESSION_ID,
  streamTransport,
  viewerIdentity,
} from "@belay/session";
import { bootStore } from "@belay/test-kit/boot";
import { afterEach, beforeEach, test } from "vitest";
import { handleSupervisorEvent, type SupervisorDeps } from "../src/dispatch";

/**
 * Supervisor project operation dispatch over a REAL session-store (plan 58 M2): a
 * browser-published `project.*.requested` event drives the injected project registry
 * and publishes the paired `project.*.result` on the control session. Fakes stand in
 * for the registry and folder picker so no real file IO or dialog fires.
 */

let store: Awaited<ReturnType<typeof bootStore>>;
let transport: ReturnType<typeof streamTransport>;
let connection: SessionConnection | undefined;

beforeEach(async () => {
  store = await bootStore();
  transport = streamTransport(store.url);
  await transport.ensureSession(SUPERVISOR_SESSION_ID);
});

afterEach(async () => {
  connection?.close();
  connection = undefined;
  await store.close();
});

/** A fake registry: an in-memory map keyed by canonical path. */
interface FakeRecord {
  path: string;
  displayName: string;
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
}

function fakeRegistry(initial: FakeRecord[] = []) {
  const map = new Map<string, FakeRecord>(initial.map((r) => [r.path, r]));
  return {
    add: (path: string, now: string) => {
      const existing = map.get(path);
      const record: FakeRecord = {
        path,
        displayName: existing?.displayName ?? path.split("/").pop() ?? path,
        collapsed: existing?.collapsed ?? false,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      map.set(path, record);
      return { path: record.path, displayName: record.displayName };
    },
    rename: (path: string, displayName: string, now: string) => {
      const existing = map.get(path);
      if (!existing) return null;
      const record = { ...existing, displayName, updatedAt: now };
      map.set(path, record);
      return { path: record.path, displayName: record.displayName };
    },
    setCollapsed: (path: string, collapsed: boolean, now: string) => {
      const existing = map.get(path);
      if (!existing) return null;
      const record = { ...existing, collapsed, updatedAt: now };
      map.set(path, record);
      return { path: record.path, collapsed: record.collapsed };
    },
    remove: (path: string) => {
      return map.delete(path);
    },
    list: () =>
      [...map.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((r) => ({
          path: r.path,
          displayPath: r.path,
          displayName: r.displayName,
          collapsed: r.collapsed,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
  };
}

/** Deps with real emit over the booted store; each test overrides only the collaborator it exercises. */
function baseDeps(over: Partial<SupervisorDeps>): SupervisorDeps {
  return {
    selfProducerId: PRODUCER_IDS.supervisor,
    emit: (event) =>
      transport.publishEvent(SUPERVISOR_SESSION_ID, {
        ...event,
        producerId: PRODUCER_IDS.supervisor,
      }),
    launch: () => Promise.resolve("launched"),
    pickFolder: () => Promise.resolve({ cancelled: true }),
    listProjects: () => [],
    projectRegistry: fakeRegistry(),
    now: () => "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function subscribe(deps: SupervisorDeps): Promise<void> {
  return new Promise<void>((resolve) => {
    connection = transport.connectSession({
      sessionId: SUPERVISOR_SESSION_ID,
      identity: viewerIdentity({
        displayName: "supervisor-test",
        instanceId: "sup-test",
        participantId: PRODUCER_IDS.supervisor,
      }),
      onEvent: (event) => void handleSupervisorEvent(event, deps),
      onReplayComplete: () => resolve(),
    });
  });
}

/** Awaits the first project-op / projects-list result matching `requestId`. */
function awaitResult(requestId: string) {
  return transport.awaitEvent(
    SUPERVISOR_SESSION_ID,
    viewerIdentity({ displayName: "reader", instanceId: "reader-1", participantId: "reader-1" }),
    (event) => {
      const decoded = decodeTrevorEvent(event);
      if (!decoded) return false;
      if (!decoded.type.startsWith("project") || !decoded.type.endsWith(".result")) return false;
      return "requestId" in decoded && decoded.requestId === requestId;
    },
    { timeoutMs: 5000 },
  );
}

test("project.add.requested with a picked folder publishes result with path and displayName", async () => {
  const registry = fakeRegistry();
  await subscribe(
    baseDeps({
      pickFolder: () => Promise.resolve({ cancelled: false, path: "/Users/me/proj" }),
      projectRegistry: registry,
    }),
  );
  await transport.publishEvent(SUPERVISOR_SESSION_ID, {
    ...events.projectAddRequested({ requestId: "pa-1" }),
    producerId: PRODUCER_IDS.web,
  });

  const decoded = decodeTrevorEvent((await awaitResult("pa-1")) ?? throwUnresolved());
  assert.deepEqual(decoded, {
    type: "project.add.result",
    requestId: "pa-1",
    path: "/Users/me/proj",
    displayName: "proj",
    cancelled: false,
  });
});

test("project.add.requested when folder pick is cancelled publishes result with cancelled: true", async () => {
  await subscribe(baseDeps({ pickFolder: () => Promise.resolve({ cancelled: true }) }));
  await transport.publishEvent(SUPERVISOR_SESSION_ID, {
    ...events.projectAddRequested({ requestId: "pa-2" }),
    producerId: PRODUCER_IDS.web,
  });

  const decoded = decodeTrevorEvent((await awaitResult("pa-2")) ?? throwUnresolved());
  assert.deepEqual(decoded, {
    type: "project.add.result",
    requestId: "pa-2",
    cancelled: true,
  });
});

test("project.rename.requested publishes result with the new name", async () => {
  const registry = fakeRegistry([
    {
      path: "/Users/me/proj",
      displayName: "proj",
      collapsed: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  await subscribe(baseDeps({ projectRegistry: registry }));

  await transport.publishEvent(SUPERVISOR_SESSION_ID, {
    ...events.projectRenameRequested({
      requestId: "pr-1",
      path: "/Users/me/proj",
      displayName: "My Project",
    }),
    producerId: PRODUCER_IDS.web,
  });

  const decoded = decodeTrevorEvent((await awaitResult("pr-1")) ?? throwUnresolved());
  assert.deepEqual(decoded, {
    type: "project.rename.result",
    requestId: "pr-1",
    path: "/Users/me/proj",
    displayName: "My Project",
  });
});

test("project.rename.requested for unknown path publishes result with error", async () => {
  await subscribe(baseDeps({ projectRegistry: fakeRegistry() }));

  await transport.publishEvent(SUPERVISOR_SESSION_ID, {
    ...events.projectRenameRequested({
      requestId: "pr-2",
      path: "/nope",
      displayName: "whatever",
    }),
    producerId: PRODUCER_IDS.web,
  });

  const decoded = decodeTrevorEvent((await awaitResult("pr-2")) ?? throwUnresolved());
  assert.deepEqual(decoded, {
    type: "project.rename.result",
    requestId: "pr-2",
    path: "/nope",
    error: "project not found",
  });
});

test("project.collapse.requested publishes result with collapsed: true", async () => {
  const registry = fakeRegistry([
    {
      path: "/Users/me/proj",
      displayName: "proj",
      collapsed: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  await subscribe(baseDeps({ projectRegistry: registry }));

  await transport.publishEvent(SUPERVISOR_SESSION_ID, {
    ...events.projectCollapseRequested({
      requestId: "pc-1",
      path: "/Users/me/proj",
      collapsed: true,
    }),
    producerId: PRODUCER_IDS.web,
  });

  const decoded = decodeTrevorEvent((await awaitResult("pc-1")) ?? throwUnresolved());
  assert.deepEqual(decoded, {
    type: "project.collapse.result",
    requestId: "pc-1",
    path: "/Users/me/proj",
    collapsed: true,
  });
});

test("project.remove.requested publishes result with removed: true", async () => {
  const registry = fakeRegistry([
    {
      path: "/Users/me/proj",
      displayName: "proj",
      collapsed: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  await subscribe(baseDeps({ projectRegistry: registry }));

  await transport.publishEvent(SUPERVISOR_SESSION_ID, {
    ...events.projectRemoveRequested({ requestId: "prm-1", path: "/Users/me/proj" }),
    producerId: PRODUCER_IDS.web,
  });

  const decoded = decodeTrevorEvent((await awaitResult("prm-1")) ?? throwUnresolved());
  assert.deepEqual(decoded, {
    type: "project.remove.result",
    requestId: "prm-1",
    path: "/Users/me/proj",
    removed: true,
  });
});

test("projects.list.result marks dead-path records missing (live ones not) without removing any record", async () => {
  const record = (path: string, updatedAt: string): FakeRecord => ({
    path,
    displayName: path.split("/").pop() ?? path,
    collapsed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  });
  const registry = fakeRegistry([
    record("/Users/me/live", "2026-01-02T00:00:00.000Z"),
    record("/Users/me/deleted", "2026-01-01T00:00:00.000Z"),
  ]);
  await subscribe(
    baseDeps({
      projectRegistry: registry,
      rootExists: (path) => path === "/Users/me/live",
    }),
  );

  await transport.publishEvent(SUPERVISOR_SESSION_ID, {
    ...events.projectsListRequested({ requestId: "pl-1" }),
    producerId: PRODUCER_IDS.web,
  });

  const decoded = decodeTrevorEvent((await awaitResult("pl-1")) ?? throwUnresolved());
  assert.equal(decoded?.type, "projects.list.result");
  if (decoded?.type === "projects.list.result") {
    assert.deepEqual(
      decoded.projects.map((p) => ({ root: p.root, missing: p.missing })),
      [
        { root: "/Users/me/live", missing: false },
        { root: "/Users/me/deleted", missing: true },
      ],
    );
    // The full registry metadata rides the result so the sidebar renders durable values - in
    // particular createdAt, its stable ordering key (it must never fall back to updatedAt).
    assert.deepEqual(
      decoded.projects.map((p) => ({
        displayPath: p.displayPath,
        displayName: p.displayName,
        collapsed: p.collapsed,
        createdAt: p.createdAt,
      })),
      [
        {
          displayPath: "/Users/me/live",
          displayName: "live",
          collapsed: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          displayPath: "/Users/me/deleted",
          displayName: "deleted",
          collapsed: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    );
  }
  // Marking is passive: the dead record stays in the registry (removal is the user's explicit action).
  assert.equal(registry.list().length, 2);
});

function throwUnresolved(): never {
  throw new Error("expected a supervisor result on the control session, got none");
}
