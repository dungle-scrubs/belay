import { events } from "@trevor/session";
import { storedLog } from "@trevor/test-kit";
import { describe, expect, it } from "vitest";
import { projectTranscript } from "./transcript";

describe("projectTranscript (M4)", () => {
  it("folds user/assistant/command/tool events into ordered entries", () => {
    const log = storedLog(
      events.userMessage({ text: "run the tool", provider: "p" }),
      events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "p" }),
      events.assistantDelta({ runId: "r1", text: "working" }),
      events.toolStarted({ runId: "r1", callId: "c1", name: "bash", arguments: "{}" }),
      events.toolCompleted({ runId: "r1", callId: "c1", name: "bash", result: "hello" }),
      events.assistantCompleted({ runId: "r1", text: "done" }),
      events.commandResult({ command: "/doctor", text: "Healthy", ok: true }),
    );

    const { entries } = projectTranscript(log);

    expect(entries.map((e) => e.role)).toEqual(["user", "tool", "assistant", "command"]);
    expect(entries[0]).toMatchObject({ role: "user", text: "run the tool" });
    expect(entries[1]).toMatchObject({ role: "tool", tool: "bash", text: "hello", runId: "r1" });
    expect(entries[2]).toMatchObject({ role: "assistant", text: "done", runId: "r1" });
    expect(entries[3]).toMatchObject({ role: "command", text: "Healthy" });
  });

  it("44.4: projects assistant.limit as a limit entry with the structured signal for automation", () => {
    const log = storedLog(
      events.userMessage({ text: "hi", provider: "anthropic" }),
      events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "anthropic" }),
      events.assistantLimit({
        provider: "anthropic",
        status: "approaching",
        scope: "five_hour",
        resetsAt: 1_780_000_000,
        utilization: 0.9,
      }),
      events.assistantCompleted({ runId: "r1", text: "done" }),
    );

    const { entries } = projectTranscript(log);
    expect(entries.map((e) => e.role)).toEqual(["user", "limit", "assistant"]);
    const limit = entries.find((e) => e.role === "limit");
    expect(limit?.limit).toEqual({
      provider: "anthropic",
      status: "approaching",
      scope: "five_hour",
      resetsAt: 1_780_000_000,
      utilization: 0.9,
    });
    // The text is a plain, structured-free line a scorer can read without re-parsing.
    expect(limit?.text).toContain("approaching");
    expect(limit?.text).toContain("anthropic");
  });

  it("ignores intermediate deltas/thinking/started and unknown events", () => {
    const log = storedLog(
      events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "p" }),
      events.assistantThinking({ runId: "r1", text: "hmm" }),
      events.assistantDelta({ runId: "r1", text: "partial" }),
    );
    expect(projectTranscript(log).entries).toHaveLength(0);
  });
});
