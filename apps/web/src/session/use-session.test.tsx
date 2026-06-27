import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import type {
  ConnectSessionOptions,
  PublishInput,
  SessionConnection,
  SessionEvent,
  SessionTransport,
} from "@trevor/session";
import { afterEach, test, vi } from "vitest";
import { useSessionWithTransport } from "./use-session";

const event = (seq: number, type: string): SessionEvent => ({
  sessionId: "s",
  seq,
  eventId: `e-${seq}`,
  type,
  producerId: "test",
  payload: {},
  createdAt: "2026-06-27T00:00:00.000Z",
});

function fakeTransport(): {
  readonly connects: ConnectSessionOptions[];
  readonly published: PublishInput[];
  readonly transport: SessionTransport;
} {
  const connects: ConnectSessionOptions[] = [];
  const published: PublishInput[] = [];
  return {
    connects,
    published,
    transport: {
      connectSession: (options): SessionConnection => {
        connects.push(options);
        options.onStatus?.("open");
        return { close: () => {} };
      },
      ensureSession: async (sessionId) => sessionId,
      publishEvent: async (_sessionId, input) => {
        published.push(input);
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test("reconnects after a closed stream and catches up from the last seen seq", async () => {
  vi.useFakeTimers();
  const { connects, transport } = fakeTransport();

  const { result, unmount } = renderHook(() => useSessionWithTransport(transport, "s"));

  assert.equal(connects.length, 1);
  act(() => {
    connects[0]?.onEvent(event(1, "first"));
    connects[0]?.onReplayComplete?.();
  });
  assert.equal(result.current.replayed, true);
  assert.deepEqual(
    result.current.events.map((e) => e.seq),
    [1],
  );

  act(() => {
    connects[0]?.onStatus?.("closed");
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });

  assert.equal(connects.length, 2);
  assert.equal(connects[1]?.afterSeq, 1);

  act(() => {
    connects[1]?.onEvent(event(2, "second"));
    connects[1]?.onReplayComplete?.();
  });
  assert.deepEqual(
    result.current.events.map((e) => e.seq),
    [1, 2],
  );

  unmount();
});
