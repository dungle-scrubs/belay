// Headless verification of Slice 1: with the host running on SESSION_ID, publish
// a user.message and assert the host echoes it back as an agent.output over the
// stream. Event-driven (no sleep). Node 22+ globals.
const BASE = process.env.RICHTER_URL ?? "http://localhost:3025";
const SID = process.env.SESSION_ID;
const MARKER = `slice1-${crypto.randomUUID()}`;
if (!SID) {
  console.error("set SESSION_ID");
  process.exit(1);
}

const params = new URLSearchParams({
  after: "0",
  capabilities: "{}",
  displayName: "verify",
  instanceId: crypto.randomUUID(),
  participantId: `verify-${crypto.randomUUID()}`,
  runtimeKind: "web",
});
const ws = new WebSocket(`${BASE.replace("http", "ws")}/sessions/${SID}/stream?${params}`);

const echoed = new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("timeout waiting for host echo (agent.output)")),
    12000,
  );
  ws.addEventListener("message", (message) => {
    const envelope = JSON.parse(String(message.data));
    if (
      envelope.op === "event" &&
      envelope.event.type === "agent.output" &&
      String(envelope.event.payload?.text).includes(MARKER)
    ) {
      clearTimeout(timeout);
      resolve(envelope.event);
    }
  });
  ws.addEventListener("error", reject);
});

await new Promise((resolve) => ws.addEventListener("open", resolve));
await fetch(`${BASE}/sessions/${SID}/events`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "user.message", producerId: "verify", payload: { text: MARKER } }),
});

const echo = await echoed;
ws.close();
console.log(`PASS: host echoed ${echo.type} "${echo.payload.text}" (producer ${echo.producerId})`);
