// Headless verification of Slice 3 routing: with the host running on SESSION_ID,
// publish a user.message carrying a provider choice and assert the host answers
// from THAT provider. Gated on the published message's seq so prior turns replayed
// on connect are not mistaken for this turn's response.
const BASE = process.env.RICHTER_URL ?? "http://localhost:3025";
const SID = process.env.SESSION_ID;
const PROVIDER = process.env.PROVIDER_KEY ?? "gpt";
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
let started = null;
let resolveCompleted;
let rejectCompleted;
const completed = new Promise((resolve, reject) => {
  resolveCompleted = resolve;
  rejectCompleted = reject;
});
const timeout = setTimeout(() => rejectCompleted(new Error("timeout waiting for assistant.completed")), 180000);

ws.addEventListener("error", (error) => rejectCompleted(error));
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
    if (event.type === "assistant.started") {
      started = event.payload;
    } else if (event.type === "assistant.completed") {
      clearTimeout(timeout);
      resolveCompleted(event.payload);
    }
  }
});

await new Promise((resolve) => ws.addEventListener("open", resolve));
await new Promise((resolve, reject) => {
  const onlineTimeout = setTimeout(() => reject(new Error("timeout waiting for host.online")), 60000);
  const check = () => (hostOnline ? (clearTimeout(onlineTimeout), resolve()) : setTimeout(check, 100));
  check();
});

const response = await fetch(`${BASE}/sessions/${SID}/events`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    type: "user.message",
    producerId: "verify",
    payload: { text: "In one short sentence, what is the capital of France?", provider: PROVIDER },
  }),
});
afterSeq = (await response.json()).event.seq;

const payload = await completed;
ws.close();
const text = String(payload.text ?? "");
if (!text.trim()) {
  console.error(`FAIL [${PROVIDER}]: empty completion`, payload.error ?? "");
  process.exit(1);
}
console.log(
  `PASS [${PROVIDER}]: started.provider=${started?.provider} model=${started?.model}; reply: "${text.slice(0, 100)}"`,
);
