// End-to-end: ask a live model to create a file via the write tool, then assert
// the file landed on disk in the workspace. Proves model -> loop -> write tool ->
// confinement all work together. Needs SESSION_ID and WORKSPACE (the host's
// TREVOR_WORKSPACE). Run after starting a host on that session+workspace.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const BASE = process.env.RICHTER_URL ?? "http://localhost:3025";
const SID = process.env.SESSION_ID;
const WORKSPACE = process.env.WORKSPACE;
const PROVIDER = process.env.PROVIDER_KEY ?? "qwen";
if (!SID || !WORKSPACE) {
  console.error("set SESSION_ID and WORKSPACE");
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
const timeout = setTimeout(() => rejectDone(new Error("timeout waiting for assistant.completed")), 180000);

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
      tools.push(event.payload.name);
    } else if (event.type === "assistant.completed") {
      clearTimeout(timeout);
      resolveDone(event.payload);
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
    payload: {
      text: "Use the write tool to create a file named trevor-e2e.txt whose entire contents are exactly: trevor-write-ok",
      provider: PROVIDER,
    },
  }),
});
afterSeq = (await response.json()).event.seq;

await done;
ws.close();

let onDisk = "";
try {
  onDisk = await readFile(join(WORKSPACE, "trevor-e2e.txt"), "utf8");
} catch (error) {
  console.error(`file not written: ${error instanceof Error ? error.message : String(error)}`);
}
console.log(`tools: ${tools.join(", ") || "none"}`);
console.log(`file contents: ${JSON.stringify(onDisk.trim())}`);
if (tools.includes("write") && onDisk.includes("trevor-write-ok")) {
  console.log(`PASS [${PROVIDER}]: model wrote the file via the write tool`);
} else {
  console.error(`FAIL [${PROVIDER}]: write used=${tools.includes("write")}, marker=${onDisk.includes("trevor-write-ok")}`);
  process.exit(1);
}
