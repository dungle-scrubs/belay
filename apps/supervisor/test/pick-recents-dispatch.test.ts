import assert from "node:assert/strict";
import {
  decodeTrevorEvent,
  events,
  PRODUCER_IDS,
  type SessionConnection,
  SUPERVISOR_SESSION_ID,
  type SupervisorProject,
  streamTransport,
  viewerIdentity,
} from "@belay/session";
import { bootStore } from "@belay/test-kit/boot";
import { afterEach, beforeEach, test } from "vitest";
import { handleSupervisorEvent, type SupervisorDeps } from "../src/dispatch";

/**
 * The supervisor folder-pick + recents dispatch over a REAL session-store (plan 44.1 M4): a
 * browser-published `folder.pick.requested` / `projects.list.requested` drives the injected picker /
 * recents reader and publishes the paired result on the control session - every exchange on the session
 * log, no private channel. Fakes stand in for the picker + registry so no real dialog fires and no real
 * file is read.
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

/** Awaits the first folder-pick / projects-list result matching `requestId`. */
function awaitResult(requestId: string) {
  return transport.awaitEvent(
    SUPERVISOR_SESSION_ID,
    viewerIdentity({ displayName: "reader", instanceId: "reader-1", participantId: "reader-1" }),
    (event) => {
      const decoded = decodeTrevorEvent(event);
      return (
        (decoded?.type === "folder.pick.result" || decoded?.type === "projects.list.result") &&
        decoded.requestId === requestId
      );
    },
    { timeoutMs: 5000 },
  );
}

test("folder.pick.requested pops the (fake) picker and returns its chosen path", async () => {
  await subscribe(
    baseDeps({ pickFolder: () => Promise.resolve({ cancelled: false, path: "/Users/me/proj" }) }),
  );
  await transport.publishEvent(SUPERVISOR_SESSION_ID, {
    ...events.folderPickRequested({ requestId: "fp-1" }),
    producerId: PRODUCER_IDS.web,
  });

  const decoded = decodeTrevorEvent((await awaitResult("fp-1")) ?? throwUnresolved());
  assert.deepEqual(decoded, {
    type: "folder.pick.result",
    requestId: "fp-1",
    cancelled: false,
    path: "/Users/me/proj",
  });
});

test("folder.pick.requested reports cancelled when the picker is dismissed / unavailable", async () => {
  await subscribe(baseDeps({ pickFolder: () => Promise.resolve({ cancelled: true }) }));
  await transport.publishEvent(SUPERVISOR_SESSION_ID, {
    ...events.folderPickRequested({ requestId: "fp-2" }),
    producerId: PRODUCER_IDS.web,
  });

  const decoded = decodeTrevorEvent((await awaitResult("fp-2")) ?? throwUnresolved());
  assert.deepEqual(decoded, { type: "folder.pick.result", requestId: "fp-2", cancelled: true });
});

test("projects.list.requested returns the recency-sorted recents", async () => {
  const projects: SupervisorProject[] = [
    { root: "/work/c", sessionId: "c-3", updatedAt: "2026-07-03T00:00:00Z" },
    { root: "/work/b", sessionId: "b-2", updatedAt: "2026-07-02T00:00:00Z" },
  ];
  await subscribe(baseDeps({ listProjects: () => projects }));
  await transport.publishEvent(SUPERVISOR_SESSION_ID, {
    ...events.projectsListRequested({ requestId: "pl-1" }),
    producerId: PRODUCER_IDS.web,
  });

  const decoded = decodeTrevorEvent((await awaitResult("pl-1")) ?? throwUnresolved());
  assert.deepEqual(decoded, { type: "projects.list.result", requestId: "pl-1", projects });
});

function throwUnresolved(): never {
  throw new Error("expected a supervisor result on the control session, got none");
}
