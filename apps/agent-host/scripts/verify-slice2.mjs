// Headless verification of Slice 2: with the host running on SESSION_ID, wait for
// host.online, send a prompt, and assert the host streams a real LM Studio
// completion (assistant.delta* -> assistant.completed with non-empty text).
const BASE = process.env.RICHTER_URL ?? "http://localhost:3025";
const SID = process.env.SESSION_ID;
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
let deltas = 0;
const completed = new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("timeout waiting for assistant.completed")),
    200000,
  );
  ws.addEventListener("message", (message) => {
    const envelope = JSON.parse(String(message.data));
    if (envelope.op !== "event") {
      return;
    }
    const event = envelope.event;
    if (event.type === "host.online") {
      hostOnline = true;
    } else if (event.type === "assistant.delta") {
      deltas += 1;
    } else if (event.type === "assistant.completed") {
      clearTimeout(timeout);
      resolve(event);
    }
  });
  ws.addEventListener("error", reject);
});

await new Promise((resolve) => ws.addEventListener("open", resolve));

// Wait for the host to go live so it does not treat our prompt as replayed history.
await new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () =>
      reject(new Error("timeout waiting for host.online (is the host running on this session?)")),
    60000,
  );
  const check = () => {
    if (hostOnline) {
      clearTimeout(timeout);
      resolve();
    } else {
      setTimeout(check, 100);
    }
  };
  check();
});

await fetch(`${BASE}/sessions/${SID}/events`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    type: "user.message",
    producerId: "verify",
    payload: { text: "Reply in one short sentence: what is the capital of France?" },
  }),
});

const event = await completed;
ws.close();
const text = String(event.payload.text ?? "");
if (!text.trim()) {
  console.error("FAIL: assistant.completed had empty text");
  process.exit(1);
}
console.log(
  `PASS: ${deltas} deltas streamed; assistant.completed (${text.length} chars): "${text.slice(0, 140)}"`,
);
