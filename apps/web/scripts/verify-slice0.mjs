// Headless verification of Slice 0's data loop against a live Richter instance:
// create a session, open the participant stream (replay-then-tail), publish an
// event over REST, and assert it arrives back over the WebSocket. Node 22+ has
// global WebSocket + fetch + crypto.
const BASE = process.env.RICHTER_URL ?? "http://localhost:3025";
const MARKER = `slice0-${crypto.randomUUID()}`;

const created = await fetch(`${BASE}/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
const { session } = await created.json();
console.log("session:", session.sessionId);

const params = new URLSearchParams({
  after: "0",
  capabilities: "{}",
  displayName: "verify",
  instanceId: crypto.randomUUID(),
  participantId: `verify-${crypto.randomUUID()}`,
  runtimeKind: "web",
});
const ws = new WebSocket(
  `${BASE.replace("http", "ws")}/sessions/${session.sessionId}/stream?${params}`,
);

let replayComplete = false;
let received = 0;
const roundTrip = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("timeout waiting for published event")), 8000);
  ws.addEventListener("message", (message) => {
    const envelope = JSON.parse(String(message.data));
    if (envelope.op === "replay.complete") {
      replayComplete = true;
    } else if (envelope.op === "event") {
      received += 1;
      if (envelope.event.payload?.text === MARKER) {
        clearTimeout(timeout);
        resolve();
      }
    }
  });
  ws.addEventListener("error", reject);
});

await new Promise((resolve) => ws.addEventListener("open", resolve));
await fetch(`${BASE}/sessions/${session.sessionId}/events`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "user.message", producerId: "verify", payload: { text: MARKER } }),
});

await roundTrip;
ws.close();
console.log(
  `PASS: replay.complete=${replayComplete}, events=${received}, publish round-trip over WS OK`,
);
