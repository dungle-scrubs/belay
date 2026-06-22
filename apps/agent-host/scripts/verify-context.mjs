// Verifies multi-turn conversation context: with the host on SESSION_ID, ask it
// to remember a value, then in a second turn ask it to recall - the recall only
// works if the host sends prior turns as context. Each turn is seq-gated.
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
let resolveTurn = null;
let turnAfterSeq = Number.POSITIVE_INFINITY;
ws.addEventListener("message", (message) => {
  const envelope = JSON.parse(String(message.data));
  if (envelope.op !== "event") {
    return;
  }
  const event = envelope.event;
  if (event.type === "host.online") {
    hostOnline = true;
  }
  if (resolveTurn && event.type === "assistant.completed" && event.seq > turnAfterSeq) {
    const resolve = resolveTurn;
    resolveTurn = null;
    resolve(String(event.payload.text ?? ""));
  }
});

await new Promise((resolve) => ws.addEventListener("open", resolve));
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("timeout waiting for host.online")), 60000);
  const check = () => (hostOnline ? (clearTimeout(timeout), resolve()) : setTimeout(check, 100));
  check();
});

async function ask(text) {
  const response = await fetch(`${BASE}/sessions/${SID}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "user.message", producerId: "verify", payload: { text, provider: PROVIDER } }),
  });
  turnAfterSeq = (await response.json()).event.seq;
  return new Promise((resolve, reject) => {
    resolveTurn = resolve;
    setTimeout(() => reject(new Error("turn timeout")), 180000);
  });
}

const turn1 = await ask("Remember the number 42. Reply with just: OK");
console.log(`turn1 -> "${turn1.trim().slice(0, 60)}"`);
const turn2 = await ask("What number did I ask you to remember? Reply with just the number.");
console.log(`turn2 -> "${turn2.trim().slice(0, 60)}"`);
ws.close();

if (turn2.includes("42")) {
  console.log(`PASS [${PROVIDER}]: context retained across turns`);
} else {
  console.error(`FAIL [${PROVIDER}]: turn 2 did not recall 42`);
  process.exit(1);
}
