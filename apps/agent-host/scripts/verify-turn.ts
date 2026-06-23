// Verifies the Effect turn pipeline (provider Stream -> runAgent Stream -> publishTurn)
// deterministically, with a fake provider that calls a tool on the first model step and
// answers on the second. Exercises the multi-step loop, real tool execution, the tool
// result threading back into the conversation, and the emitted event sequence - without
// depending on a model choosing to call a tool. Run: pnpm exec tsx scripts/verify-turn.ts
import type { TrevorEventInput } from "@trevor/richter";
import { Effect, Layer, Stream } from "effect";
import type { ChatMessage, Provider, ProviderEvent } from "../src/providers";
import { Emit } from "../src/services";
import { publishTurn } from "../src/turn";

const usage = { input: 10, output: 5, contextWindow: 1000, genMs: 1 };

// Step 1 (no tool result yet): emit a bash tool call. Step 2 (tool result present): answer.
const fakeProvider: Provider = {
  id: "fake",
  label: "Fake",
  model: "fake-1",
  reasoningLevels: [],
  defaultReasoning: "off",
  readiness: () => Effect.succeed({ ready: true, warm: true }),
  warm: () => Effect.void,
  stream: (messages) => {
    const answered = messages.some((m) => m.role === "tool");
    const evs: ProviderEvent[] = answered
      ? [
          { type: "text", text: "Done: " },
          { type: "text", text: "the tool ran." },
          { type: "usage", usage },
        ]
      : [
          { type: "text", text: "Let me run a command. " },
          {
            type: "tool_call",
            call: {
              id: "c1",
              name: "bash",
              arguments: JSON.stringify({ command: "echo hello-from-tool" }),
            },
          },
          { type: "usage", usage },
        ];
    return Stream.fromIterable(evs);
  },
};

// A test Emit layer collects the published events - the DI seam the Emit service buys.
const collected: TrevorEventInput[] = [];
const EmitTest = Layer.succeed(Emit, {
  publish: (event) => Effect.sync(() => void collected.push(event)),
});

const history: ChatMessage[] = [{ role: "user", content: "Please run echo hello-from-tool." }];
await Effect.runPromise(
  publishTurn(fakeProvider, history, { runId: "r1" }).pipe(Effect.provide(EmitTest)),
);

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (!ok) {
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
    failures += 1;
  }
};

const types = collected.map((e) => e.type);
const payloadOf = (type: string) => collected.find((e) => e.type === type)?.payload;
const completed = collected.filter((e) => e.type === "assistant.completed");
const final = completed[0]?.payload;
const finalText = String(final?.text ?? "");

check("started-first", types[0] === "assistant.started", types.join(","));
check("tool-started", types.includes("tool.started"));
check("tool-name-bash", payloadOf("tool.started")?.name === "bash");
check(
  "tool-ran-echo",
  String(payloadOf("tool.completed")?.result ?? "").includes("hello-from-tool"),
  String(payloadOf("tool.completed")?.result ?? ""),
);
check("one-completed", completed.length === 1, `count=${completed.length}`);
check("no-error", final?.error === undefined, String(final?.error));
check(
  "final-text-threaded",
  finalText.includes("Let me run a command.") && finalText.includes("the tool ran."),
  finalText,
);
check(
  "ordering",
  types.indexOf("tool.started") < types.indexOf("tool.completed") &&
    types.indexOf("tool.completed") < types.lastIndexOf("assistant.completed"),
  types.join(" -> "),
);

if (failures === 0) {
  console.log(`TURN PASS (${types.join(" -> ")})`);
} else {
  console.error(`TURN FAIL (${failures})`);
  process.exit(1);
}
