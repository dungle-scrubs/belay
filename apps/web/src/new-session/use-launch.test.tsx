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
import { test, vi } from "vitest";
import { useSessionWithTransport } from "@/session/use-session";
import { useLaunch } from "./use-launch";

/**
 * Plan 44.3 M2.7: the shared launch primitive, driven through the recording transport. It mirrors the
 * launch cases of `use-supervisor.test.tsx` (reused-navigates, launched-awaits-host.online, timeout,
 * failed) and adds the 44.3 recovery cases (failed IS a state, retry re-publishes, a stale-host restart
 * still navigates). The CALLER owns the control subscription here exactly as the real surfaces do, so the
 * one machine is exercised the same way the picker and the session view drive it.
 */

const controlConnect = (connects: readonly ConnectSessionOptions[]) =>
  connects.find((c) => c.sessionId === SUPERVISOR_SESSION_ID);

const launchesOf = (published: readonly PublishInput[]) =>
  published.filter((p) => p.type === "session.launch.requested");

function deliverControl(
  connects: readonly ConnectSessionOptions[],
  input: TrevorEventInput,
  seq: number,
): void {
  controlConnect(connects)?.onEvent(
    storedEvent(input, { sessionId: SUPERVISOR_SESSION_ID, seq, producerId: "supervisor" }),
  );
}

function renderLaunch(over: { onNavigate?: () => void } = {}) {
  const rec = recordingTransport();
  const onNavigate = vi.fn(over.onNavigate);
  // The caller owns the control subscription (here always open, like the session view once armed); the
  // hook only folds the events it is handed - the ONE result-fold the picker also uses.
  const view = renderHook(() => {
    const control = useSessionWithTransport(rec.transport, SUPERVISOR_SESSION_ID);
    return useLaunch({
      controlEvents: control.events,
      onNavigate,
      transport: rec.transport,
      hostOnlineTimeoutMs: 50,
    });
  });
  return { rec, onNavigate, ...view };
}

const lastLaunchRequestId = (rec: ReturnType<typeof recordingTransport>): string =>
  launchesOf(rec.publishedBy(SUPERVISOR_SESSION_ID)).at(-1)?.payload.requestId as string;

test("launch publishes session.launch.requested { root } and enters starting", async () => {
  const { rec, result } = renderLaunch();
  await act(async () => {});

  act(() => result.current.launch("~/dev/new-thing"));
  assert.equal(result.current.launchState, "starting", "the launch shows starting host…");
  assert.equal(result.current.inFlight, true, "a launch in flight reports inFlight");
  const req = launchesOf(rec.publishedBy(SUPERVISOR_SESSION_ID)).at(-1);
  assert.ok(req, "publishes a launch request");
  assert.equal(req.producerId, PRODUCER_IDS.web, "stamped with the web producer id");
  assert.equal(req.payload.root, "~/dev/new-thing", "carries the chosen root");
});

test("a reused host navigates immediately without a host.online wait", async () => {
  const { rec, result, onNavigate } = renderLaunch();
  await act(async () => {});

  act(() => result.current.launch("~/dev/trevor"));
  act(() => {
    deliverControl(
      rec.connects,
      sessionEvents.sessionLaunchResult({
        requestId: lastLaunchRequestId(rec),
        sessionId: "sess-reused",
        status: "reused",
      }),
      1,
    );
  });
  assert.deepEqual(onNavigate.mock.calls, [["sess-reused"]], "a reused host navigates at once");
  assert.equal(
    result.current.launchState,
    "idle",
    "a reused host resolves back to idle so a no-op navigate (session view) is not stuck on starting",
  );
});

test("a freshly launched host navigates only after its host.online", async () => {
  const { rec, result, onNavigate } = renderLaunch();
  await act(async () => {});
  rec.seed("sess-new", [
    storedEvent(
      { type: "host.online", payload: {} },
      { sessionId: "sess-new", seq: 1, eventId: "h1", producerId: "host" },
    ) as SessionEvent,
  ]);

  act(() => result.current.launch("~/dev/new-thing"));
  act(() => {
    deliverControl(
      rec.connects,
      sessionEvents.sessionLaunchResult({
        requestId: lastLaunchRequestId(rec),
        sessionId: "sess-new",
        status: "launched",
      }),
      1,
    );
  });
  assert.equal(onNavigate.mock.calls.length, 0, "a launched host waits for host.online");
  await act(async () => {}); // flush the awaitEvent replay + navigation
  assert.deepEqual(onNavigate.mock.calls, [["sess-new"]], "navigates once host.online arrives");
});

test("a launched host that never comes online gives up: idle + error, no navigate", async () => {
  const { rec, result, onNavigate } = renderLaunch();
  await act(async () => {});

  act(() => result.current.launch("~/dev/never"));
  act(() => {
    deliverControl(
      rec.connects,
      sessionEvents.sessionLaunchResult({
        requestId: lastLaunchRequestId(rec),
        sessionId: "sess-dead",
        status: "launched",
      }),
      1,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 90));
  });
  assert.equal(
    onNavigate.mock.calls.length,
    0,
    "a host that never comes online is not navigated to",
  );
  assert.equal(result.current.launchState, "idle", "the launch gives up back to idle");
  assert.ok(result.current.error, "a give-up surfaces an inline error");
});

test("a failed launch enters the failed state with a named error and does not navigate", async () => {
  const { rec, result, onNavigate } = renderLaunch();
  await act(async () => {});

  act(() => result.current.launch("~/dev/new-thing"));
  act(() => {
    deliverControl(
      rec.connects,
      sessionEvents.sessionLaunchResult({
        requestId: lastLaunchRequestId(rec),
        sessionId: "sess-x",
        status: "failed",
        error: "no local supervisor",
      }),
      1,
    );
  });
  assert.equal(result.current.launchState, "failed", "a failed launch enters the failed state");
  assert.equal(result.current.error, "no local supervisor", "the error names the failure class");
  assert.equal(onNavigate.mock.calls.length, 0, "a failed launch never navigates");
});

test("retry re-publishes the last attempted root and returns to starting", async () => {
  const { rec, result } = renderLaunch();
  await act(async () => {});

  act(() => result.current.launch("~/dev/retry-me"));
  act(() => {
    deliverControl(
      rec.connects,
      sessionEvents.sessionLaunchResult({
        requestId: lastLaunchRequestId(rec),
        sessionId: "sess-x",
        status: "failed",
        error: "spawn denied",
      }),
      1,
    );
  });
  assert.equal(result.current.launchState, "failed");

  act(() => result.current.retry());
  const launches = launchesOf(rec.publishedBy(SUPERVISOR_SESSION_ID));
  assert.equal(launches.length, 2, "retry publishes a second launch request");
  assert.equal(launches[1]?.payload.root, "~/dev/retry-me", "retry reuses the same root");
  assert.notEqual(
    launches[0]?.payload.requestId,
    launches[1]?.payload.requestId,
    "each attempt mints a fresh request id",
  );
  assert.equal(result.current.launchState, "starting", "retry returns to starting host…");
  assert.equal(result.current.error, null, "retry clears the prior error");
});

test("a launched host whose session already had a host.online navigates (a stale-host restart)", async () => {
  // The session-view restart target is an existing session with a prior (now-dead) host.online in its
  // log. The launch resolves `launched`; awaitEvent finds a host.online and navigates (to the session
  // already in view, a harmless no-op there). The "restarting host…" LABEL is a render-site decision
  // (`hostAnnouncement(events) !== null`), covered in host-launch-status.test.tsx.
  const { rec, result, onNavigate } = renderLaunch();
  await act(async () => {});
  rec.seed("sess-stale", [
    storedEvent(
      { type: "host.online", payload: {} },
      { sessionId: "sess-stale", seq: 1, eventId: "h-old", producerId: "host" },
    ) as SessionEvent,
  ]);

  act(() => result.current.launch("~/dev/trevor"));
  act(() => {
    deliverControl(
      rec.connects,
      sessionEvents.sessionLaunchResult({
        requestId: lastLaunchRequestId(rec),
        sessionId: "sess-stale",
        status: "launched",
      }),
      1,
    );
  });
  await act(async () => {});
  assert.deepEqual(onNavigate.mock.calls, [["sess-stale"]], "a restart target still resolves");
});

test("reset returns to idle and invalidates a pending host.online navigation", async () => {
  const { rec, result, onNavigate } = renderLaunch();
  await act(async () => {});
  rec.seed("sess-late", [
    storedEvent(
      { type: "host.online", payload: {} },
      { sessionId: "sess-late", seq: 1, eventId: "h1", producerId: "host" },
    ) as SessionEvent,
  ]);

  act(() => result.current.launch("~/dev/x"));
  act(() => {
    deliverControl(
      rec.connects,
      sessionEvents.sessionLaunchResult({
        requestId: lastLaunchRequestId(rec),
        sessionId: "sess-late",
        status: "launched",
      }),
      1,
    );
  });
  // Reset (a session switch / picker close) before the host.online watch resolves.
  act(() => result.current.reset());
  assert.equal(result.current.launchState, "idle", "reset returns to idle");
  await act(async () => {}); // let the superseded awaitEvent settle
  assert.equal(onNavigate.mock.calls.length, 0, "a reset launch never navigates late");
});
