// Sends one turn and counts how many distinct hosts answer it (distinct runIds
// across assistant.started). With the lease working there must be exactly ONE,
// no matter how many hosts share the session. Needs SESSION_ID.
const BASE = process.env.RICHTER_URL ?? "http://localhost:3025";
const SID = process.env.SESSION_ID;
const PROVIDER = process.env.PROVIDER_KEY ?? "qwen";
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 15000);
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

let hostOnline = false;
let afterSeq = -1;
const runIds = new Set();
let completed = 0;

ws.addEventListener("message", (message) => {
  const envelope = JSON.parse(String(message.data));
  if (envelope.op !== "event") {
    return;
  }
  const event = envelope.event;
  if (event.type === "host.online") {
    hostOnline = true;
  }
  if (afterSeq >= 0 && event.seq > afterSeq) {
    if (event.type === "assistant.started" && typeof event.payload.runId === "string") {
      runIds.add(event.payload.runId);
    } else if (event.type === "assistant.completed") {
      completed += 1;
    }
  }
});

await new Promise((resolve) => ws.addEventListener("open", resolve));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("timeout waiting for host.online")), 30000);
  const check = () => (hostOnline ? (clearTimeout(t), resolve()) : setTimeout(check, 100));
  check();
});

const response = await fetch(`${BASE}/sessions/${SID}/events`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    type: "user.message",
    producerId: "verify",
    payload: { text: "Reply with exactly: pong", provider: PROVIDER },
  }),
});
afterSeq = (await response.json()).event.seq;

await new Promise((resolve) => setTimeout(resolve, WINDOW_MS));
ws.close();

console.log(`responders (distinct runIds): ${runIds.size}, completions: ${completed}`);
if (runIds.size === 1 && completed >= 1) {
  console.log("LEASE-E2E PASS: exactly one host answered");
} else {
  console.error(`LEASE-E2E FAIL: expected exactly 1 responder with a completion`);
  process.exit(1);
}
