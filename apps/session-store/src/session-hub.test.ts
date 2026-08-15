import assert from "node:assert/strict";
import { frames, type HostPresence, type StreamEnvelope } from "@belay/session";
import { test } from "vitest";
import type { WebSocket } from "ws";
import { SessionHub } from "./session-hub";

class FakeSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly sent: StreamEnvelope[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as StreamEnvelope);
  }

  asSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

const host = (instanceId: string, displayName = instanceId): HostPresence => ({
  instanceId,
  participantId: instanceId,
  displayName,
});

test("viewer attach receives current presence without broadcasting to existing subscribers", () => {
  const hub = new SessionHub();
  const existing = new FakeSocket();
  const viewer = new FakeSocket();

  hub.attach("s", existing.asSocket());
  existing.sent.length = 0;
  hub.attach("s", viewer.asSocket());

  assert.deepEqual(existing.sent, []);
  assert.deepEqual(viewer.sent, [frames.presence([])]);
});

test("host attach broadcasts de-duplicated live presence to the session", () => {
  const hub = new SessionHub();
  const viewer = new FakeSocket();
  const firstHost = new FakeSocket();
  const reconnectingHost = new FakeSocket();

  hub.attach("s", viewer.asSocket());
  viewer.sent.length = 0;
  hub.attach("s", firstHost.asSocket(), { host: host("h1", "first") });
  hub.attach("s", reconnectingHost.asSocket(), { host: host("h1", "second") });

  assert.deepEqual(viewer.sent.at(-1), frames.presence([host("h1", "second")]));
  assert.deepEqual(hub.hostsOf("s"), [host("h1", "second")]);
  assert.equal(hub.hasLiveHost("s"), true);
});

test("detach removes subscribers and broadcasts host departure once", () => {
  const hub = new SessionHub();
  const viewer = new FakeSocket();
  const hostSocket = new FakeSocket();

  hub.attach("s", viewer.asSocket());
  hub.attach("s", hostSocket.asSocket(), { host: host("h1") });
  viewer.sent.length = 0;
  hub.detach("s", hostSocket.asSocket());

  assert.deepEqual(viewer.sent, [frames.presence([])]);
  assert.deepEqual(hub.hostsOf("s"), []);
  assert.equal(hub.hasLiveHost("s"), false);

  hub.publish("s", frames.replayComplete());
  assert.deepEqual(
    hostSocket.sent.map((frame) => frame.op),
    ["presence"],
  );
});
