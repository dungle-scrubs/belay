// Verifies the agent loop: ask the model to run a shell command via the bash tool
// and report the output. Passes only if the host emitted a tool call AND the final
// answer contains the command's output (so the loop fed the tool result back).
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

let hostOnline = false;
let afterSeq = -1;
const tools = [];
let resolveDone;
let rejectDone;
const done = new Promise((resolve, reject) => {
  resolveDone = resolve;
  rejectDone = reject;
});
const timeout = setTimeout(
  () => rejectDone(new Error("timeout waiting for assistant.completed")),
  180000,
);

ws.addEventListener("error", (error) => rejectDone(error));
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
    if (event.type === "tool.started") {
      tools.push({ name: event.payload.name, args: event.payload.arguments });
    } else if (event.type === "assistant.completed") {
      clearTimeout(timeout);
      resolveDone(event.payload);
    }
  }
});

await new Promise((resolve) => ws.addEventListener("open", resolve));
await new Promise((resolve, reject) => {
  const onlineTimeout = setTimeout(
    () => reject(new Error("timeout waiting for host.online")),
    60000,
  );
  const check = () =>
    hostOnline ? (clearTimeout(onlineTimeout), resolve()) : setTimeout(check, 100);
  check();
});

const response = await fetch(`${BASE}/sessions/${SID}/events`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    type: "user.message",
    producerId: "verify",
    payload: {
      text: "Use the bash tool to run the command: echo trevor-agent-ok . Then reply with exactly what it printed.",
      provider: PROVIDER,
    },
  }),
});
afterSeq = (await response.json()).event.seq;

const payload = await done;
ws.close();
const text = String(payload.text ?? "");
console.log(
  `tools: ${tools.map((t) => `${t.name}(${String(t.args).slice(0, 40)})`).join(", ") || "none"}`,
);
console.log(`final: "${text.trim().slice(0, 100)}"`);
if (tools.length > 0 && text.includes("trevor-agent-ok")) {
  console.log(`PASS [${PROVIDER}]: agent called a tool and used its result`);
} else {
  console.error(
    `FAIL [${PROVIDER}]: tools=${tools.length}, marker=${text.includes("trevor-agent-ok")}`,
  );
  process.exit(1);
}
