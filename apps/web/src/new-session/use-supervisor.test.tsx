import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import {
  type ConnectSessionOptions,
  PRODUCER_IDS,
  type PublishInput,
  type SessionEvent,
  SUPERVISOR_SESSION_ID,
  events as sessionEvents,
  type TrevorEventInput,
} from "@trevor/session";
import { recordingTransport, storedEvent } from "@trevor/test-kit";
import { afterEach, test, vi } from "vitest";
import { TAIL_FLUSH_MS } from "@/session/use-session";
import { useSupervisor } from "./use-supervisor";

/**
 * Plan 44.2 M3/M4: the New-session picker's live wiring over the 44.1 supervisor control session,
 * driven through the recording transport. Proves the projects fetch on open, the native folder fill
 * (and no-op cancel), path validation, and the launch state machine (starting -> reused-immediate /
 * launched-await-host.online / failed-inline-error).
 */

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Commits buffered live tail events: the session hook batches tail deltas into one commit per
 * TAIL_FLUSH_MS window (Tier 2.1), so a delivered control event only folds after the flush timer
 * fires. Tests run under fake timers (real microtasks) so the flush is advanced deterministically.
 */
const flushControl = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(TAIL_FLUSH_MS);
  });

const controlConnect = (connects: readonly ConnectSessionOptions[]) =>
  connects.find((c) => c.sessionId === SUPERVISOR_SESSION_ID);

const publishedTo = (published: readonly PublishInput[], type: string) =>
  published.find((p) => p.type === type);

/** Delivers a supervisor result on the (already replayed) control session, as a live tail event. */
function deliverControl(
  connects: readonly ConnectSessionOptions[],
  input: TrevorEventInput,
  seq: number,
): void {
  controlConnect(connects)?.onEvent(
    storedEvent(input, { sessionId: SUPERVISOR_SESSION_ID, seq, producerId: "supervisor" }),
  );
}

function renderSupervisor(over: { localPickerAvailable?: boolean; onNavigate?: () => void } = {}) {
  const rec = recordingTransport();
  const onNavigate = vi.fn(over.onNavigate);
  const view = renderHook(() =>
    useSupervisor({
      active: true,
      localPickerAvailable: over.localPickerAvailable ?? true,
      onNavigate,
      transport: rec.transport,
      hostOnlineTimeoutMs: 50,
    }),
  );
  return { rec, onNavigate, ...view };
}

test("opening the picker publishes projects.list.requested and renders the returned recents", async () => {
  vi.useFakeTimers();
  const { rec, result } = renderSupervisor();
  await act(async () => {});

  const req = publishedTo(rec.publishedBy(SUPERVISOR_SESSION_ID), "projects.list.requested");
  assert.ok(req, "publishes a projects.list request on open");
  assert.equal(req.producerId, PRODUCER_IDS.web, "stamped with the web producer id");
  const requestId = req.payload.requestId as string;

  act(() => {
    deliverControl(
      rec.connects,
      sessionEvents.projectsListResult({
        requestId,
        projects: [
          { root: "~/dev/trevor", sessionId: "s1", updatedAt: "2026-07-04T11:00:00.000Z" },
        ],
      }),
      1,
    );
  });
  await flushControl();
  assert.deepEqual(
    result.current.recents.map((r) => r.root),
    ["~/dev/trevor"],
  );
});

test("the folder icon publishes folder.pick.requested and fills the path from the result", async () => {
  vi.useFakeTimers();
  const { rec, result } = renderSupervisor();
  await act(async () => {});

  act(() => result.current.onPickFolder());
  const req = publishedTo(rec.publishedBy(SUPERVISOR_SESSION_ID), "folder.pick.requested");
  assert.ok(req, "the folder icon requests a native pick");
  const requestId = req.payload.requestId as string;

  act(() => {
    deliverControl(
      rec.connects,
      sessionEvents.folderPickResult({ requestId, path: "/picked/dir", cancelled: false }),
      1,
    );
  });
  await flushControl();
  assert.equal(result.current.path, "/picked/dir", "the chosen path fills the field");
  assert.equal(result.current.validation, "valid", "an absolute path validates");
});

test("a cancelled folder pick is a no-op (the path is unchanged)", async () => {
  vi.useFakeTimers();
  const { rec, result } = renderSupervisor();
  await act(async () => {});
  act(() => result.current.onPathChange("~/existing"));

  act(() => result.current.onPickFolder());
  const req = publishedTo(rec.publishedBy(SUPERVISOR_SESSION_ID), "folder.pick.requested");
  const requestId = req?.payload.requestId as string;
  act(() => {
    deliverControl(rec.connects, sessionEvents.folderPickResult({ requestId, cancelled: true }), 1);
  });
  await flushControl();
  assert.equal(result.current.path, "~/existing", "a cancel leaves the typed path alone");
});

test("the folder icon is inert when no local picker is available", async () => {
  const { rec, result } = renderSupervisor({ localPickerAvailable: false });
  await act(async () => {});
  act(() => result.current.onPickFolder());
  assert.equal(
    publishedTo(rec.publishedBy(SUPERVISOR_SESSION_ID), "folder.pick.requested"),
    undefined,
    "no folder.pick request without a local supervisor",
  );
});

test("path validation gates: empty/invalid/valid", async () => {
  const { result } = renderSupervisor();
  await act(async () => {});
  assert.equal(result.current.validation, "empty", "no path is empty");
  act(() => result.current.onPathChange("not-a-path"));
  assert.equal(result.current.validation, "invalid", "a bare name is invalid");
  act(() => result.current.onPathChange("~/dev/x"));
  assert.equal(result.current.validation, "valid", "a home path is valid");
});

test("Create publishes session.launch.requested { root } and enters starting", async () => {
  const { rec, result } = renderSupervisor();
  await act(async () => {});

  act(() => result.current.onCreate("~/dev/new-thing"));
  assert.equal(result.current.launchState, "starting", "the launch shows starting host…");
  const req = publishedTo(rec.publishedBy(SUPERVISOR_SESSION_ID), "session.launch.requested");
  assert.ok(req, "publishes a launch request");
  assert.equal(req.payload.root, "~/dev/new-thing", "carries the chosen root");
});

test("a reused host navigates immediately without a host.online wait", async () => {
  vi.useFakeTimers();
  const { rec, result, onNavigate } = renderSupervisor();
  await act(async () => {});

  act(() => result.current.onPickRecent("~/dev/trevor"));
  const requestId = publishedTo(rec.publishedBy(SUPERVISOR_SESSION_ID), "session.launch.requested")
    ?.payload.requestId as string;
  act(() => {
    deliverControl(
      rec.connects,
      sessionEvents.sessionLaunchResult({ requestId, sessionId: "sess-reused", status: "reused" }),
      1,
    );
  });
  await flushControl();
  assert.deepEqual(onNavigate.mock.calls, [["sess-reused"]], "a reused host navigates at once");
});

test("a freshly launched host navigates only after its host.online", async () => {
  vi.useFakeTimers();
  const { rec, result, onNavigate } = renderSupervisor();
  await act(async () => {});
  // The new session announces host.online on its OWN log (seeded so awaitEvent resolves).
  rec.seed("sess-new", [
    storedEvent(
      { type: "host.online", payload: {} },
      { sessionId: "sess-new", seq: 1, eventId: "h1", producerId: "host" },
    ) as SessionEvent,
  ]);

  act(() => result.current.onCreate("~/dev/new-thing"));
  const requestId = publishedTo(rec.publishedBy(SUPERVISOR_SESSION_ID), "session.launch.requested")
    ?.payload.requestId as string;
  act(() => {
    deliverControl(
      rec.connects,
      sessionEvents.sessionLaunchResult({ requestId, sessionId: "sess-new", status: "launched" }),
      1,
    );
  });
  // Synchronous advance: the tail flush commits and the fold starts the host.online watch, but its
  // microtask replay has not run yet. Before host.online is observed, no navigation has happened.
  act(() => {
    vi.advanceTimersByTime(TAIL_FLUSH_MS);
  });
  assert.equal(onNavigate.mock.calls.length, 0, "a launched host waits for host.online");
  await act(async () => {}); // flush the awaitEvent replay + navigation
  assert.deepEqual(onNavigate.mock.calls, [["sess-new"]], "navigates once host.online arrives");
});

test("a launched host that never comes online gives up: idle + error, no navigate", async () => {
  vi.useFakeTimers();
  const { rec, result, onNavigate } = renderSupervisor();
  await act(async () => {});
  // Do NOT seed host.online for the target session, so awaitEvent times out (resolves null at 50ms).
  act(() => result.current.onCreate("~/dev/never"));
  const requestId = publishedTo(rec.publishedBy(SUPERVISOR_SESSION_ID), "session.launch.requested")
    ?.payload.requestId as string;
  act(() => {
    deliverControl(
      rec.connects,
      sessionEvents.sessionLaunchResult({ requestId, sessionId: "sess-dead", status: "launched" }),
      1,
    );
  });
  await flushControl();
  // Let the host.online wait window (50ms) elapse and resolve null.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90);
  });
  assert.equal(
    onNavigate.mock.calls.length,
    0,
    "a host that never comes online is not navigated to",
  );
  assert.equal(result.current.launchState, "idle", "the launch gives up back to idle");
  assert.ok(result.current.error, "a give-up surfaces an inline error");
});

test("a failed launch surfaces a named error in the failed state and does not navigate", async () => {
  vi.useFakeTimers();
  const { rec, result, onNavigate } = renderSupervisor();
  await act(async () => {});

  act(() => result.current.onCreate("~/dev/new-thing"));
  const requestId = publishedTo(rec.publishedBy(SUPERVISOR_SESSION_ID), "session.launch.requested")
    ?.payload.requestId as string;
  act(() => {
    deliverControl(
      rec.connects,
      sessionEvents.sessionLaunchResult({
        requestId,
        sessionId: "sess-x",
        status: "failed",
        error: "no local supervisor",
      }),
      1,
    );
  });
  await flushControl();
  // 44.3: a failed launch is a first-class recovery state (error + Retry), not a silent drop to idle.
  assert.equal(result.current.launchState, "failed", "a failed launch enters the failed state");
  assert.equal(result.current.error, "no local supervisor", "the error surfaces inline");
  assert.equal(onNavigate.mock.calls.length, 0, "a failed launch never navigates");
});
