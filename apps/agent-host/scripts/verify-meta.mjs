// Verifies the run/host metadata: host.online carries cwd/workspace, and a turn's
// assistant.completed carries usage (input/output/contextWindow). Needs SESSION_ID.
const BASE = process.env.RICHTER_URL ?? "http://localhost:3025";
const SID = process.env.SESSION_ID;
const PROVIDER = process.env.PROVIDER_KEY ?? "qwen";
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

let online = null;
let afterSeq = -1;
let resolveDone;
let rejectDone;
const done = new Promise((resolve, reject) => {
  resolveDone = resolve;
  rejectDone = reject;
});
const timeout = setTimeout(
  () => rejectDone(new Error("timeout waiting for assistant.completed")),
  120000,
);

ws.addEventListener("message", (message) => {
  const envelope = JSON.parse(String(message.data));
  if (envelope.op !== "event") {
    return;
  }
  const event = envelope.event;
  if (event.type === "host.online") {
    online = event.payload;
  }
  if (afterSeq >= 0 && event.seq > afterSeq && event.type === "assistant.completed") {
    clearTimeout(timeout);
    resolveDone(event.payload);
  }
});

await new Promise((resolve) => ws.addEventListener("open", resolve));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("timeout waiting for host.online")), 30000);
  const check = () => (online ? (clearTimeout(t), resolve()) : setTimeout(check, 100));
  check();
});

console.log(
  `host.online -> workspace: ${JSON.stringify(online.workspace)}, cwd: ${JSON.stringify(online.cwd)}`,
);

const response = await fetch(`${BASE}/sessions/${SID}/events`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    type: "user.message",
    producerId: "verify",
    payload: {
      text: process.env.PROMPT ?? "Reply with exactly one word: hi",
      provider: PROVIDER,
    },
  }),
});
afterSeq = (await response.json()).event.seq;

const completed = await done;
ws.close();
console.log(`assistant.completed -> usage: ${JSON.stringify(completed.usage)}`);

const usage = completed.usage;
const tokps = usage && usage.genMs > 0 ? Math.round(usage.output / (usage.genMs / 1000)) : 0;
const okWorkspace = typeof online.workspace === "string" && online.workspace.length > 0;
const okUsage =
  usage && typeof usage.input === "number" && usage.contextWindow > 0 && usage.genMs > 0;
if (okWorkspace && okUsage) {
  console.log(
    `META PASS [${PROVIDER}]: workspace + usage ${usage.input}/${usage.contextWindow} ctx + ${tokps} tok/s`,
  );
} else {
  console.error(`META FAIL: workspace=${okWorkspace}, usage=${okUsage} (genMs=${usage?.genMs})`);
  process.exit(1);
}
