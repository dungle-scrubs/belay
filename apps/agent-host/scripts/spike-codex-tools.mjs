// Spike: validate a full pi-ai/codex tool round-trip - define a tool, get the
// tool call, feed a toolResult back (fabricated assistant message, matching how
// the provider must rebuild history), and confirm the final answer uses it.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { getModel, streamSimple, Type } from "@mariozechner/pi-ai";
import { getOAuthApiKey } from "@mariozechner/pi-ai/oauth";

const auth = JSON.parse(await readFile(`${homedir()}/.pi/auth.json`, "utf8"));
const resolved = await getOAuthApiKey("openai-codex", { "openai-codex": auth["openai-codex"] });
const model = getModel("openai-codex", process.env.PIAI_MODEL ?? "gpt-5.5");
// RAW_SCHEMA=1 tests whether a plain JSON schema works as Tool.parameters (vs typebox).
const RAW = process.env.RAW_SCHEMA === "1";
const tools = [
  {
    name: "bash",
    description: "Run a shell command and return its output.",
    parameters: RAW
      ? { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
      : Type.Object({ command: Type.String() }),
  },
];

async function step(messages) {
  let text = "";
  let toolCall = null;
  for await (const event of streamSimple(model, { messages, tools }, { apiKey: resolved.apiKey })) {
    if (event.type === "text_delta") {
      text += event.delta;
    } else if (event.type === "toolcall_end") {
      toolCall = event.toolCall;
    }
  }
  return { text, toolCall };
}

const messages = [
  {
    role: "user",
    content: "Use the bash tool to run: echo spike-hi . Then reply with exactly what it printed.",
    timestamp: Date.now(),
  },
];

let result = await step(messages);
console.log(
  `r1 tool: ${result.toolCall ? `${result.toolCall.name}(${JSON.stringify(result.toolCall.arguments)})` : "none"}`,
);

if (result.toolCall) {
  // Fabricated assistant turn (role + content holding the ToolCall) + the toolResult.
  messages.push({ role: "assistant", content: [result.toolCall], timestamp: Date.now() });
  messages.push({
    role: "toolResult",
    toolCallId: result.toolCall.id,
    toolName: result.toolCall.name,
    content: [{ type: "text", text: "spike-hi" }],
    isError: false,
    timestamp: Date.now(),
  });
  result = await step(messages);
  console.log(`r2 final: ${JSON.stringify(result.text.trim().slice(0, 80))}`);
  console.log(result.text.includes("spike-hi") ? "SPIKE PASS" : "SPIKE FAIL");
} else {
  console.log("SPIKE FAIL: no tool call");
}
