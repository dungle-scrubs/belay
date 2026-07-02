import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TurnHooks } from "@host/agent/loop";
import type { StopOutcome } from "@host/hooks/runtime";
import {
  type ChatMessage,
  type ProviderEvent,
  ProviderUnavailable,
  type ToolDef,
} from "@host/providers";
import type { TrevorEventInput } from "@trevor/session";
import { Stream } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import { fakeProvider, runTurn } from "../support/fake-provider";
import { type HooksRuntimeHarness, hooksRuntimeHarness } from "./runtime-fixture";

/**
 * Stop one-pass continuation (plan 25 M8, D-004): a Stop hook's bounded context buys AT MOST one
 * tool-less synthesis pass inside the same run - the context reaches the model as a user message
 * on the next provider call, the pass's text streams onto the same completion, the re-dispatch
 * lets the hook review the true final text (halt still honored), and a second continuation
 * request is ignored with a diagnostic. The no-mutation proofs: the pass offers ZERO tools (a
 * stray tool_call is dropped, nothing executes) and a Stop hook's JSON changes no workspace byte.
 *
 * Responsible for: exercising the publishTurn continuation budget end to end.
 * Not for: single-dispatch semantics - ./stop-dispatch.test.ts and ./stop-turn.test.ts.
 */

const CONTEXT = JSON.stringify({ decision: "allow", context: "cover the risks" });

const USAGE: ProviderEvent = {
  type: "usage",
  usage: { input: 10, output: 5, contextWindow: 100_000, genMs: 1 },
};

let harness: HooksRuntimeHarness | undefined;

function using(built: HooksRuntimeHarness): HooksRuntimeHarness {
  harness = built;
  return built;
}

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

function turnHooks(h: HooksRuntimeHarness, overrides: Partial<TurnHooks> = {}): TurnHooks {
  return {
    dispatchPreToolUse: h.runtime.dispatchPreToolUse,
    dispatchStop: h.runtime.dispatchStop,
    hasHooks: h.runtime.hasHooks,
    identity: { sessionId: "s-continue", callerKind: "main", cwd: h.workspaceRoot },
    ...overrides,
  };
}

const payloadOf = (events: TrevorEventInput[], type: string) =>
  events.find((event) => event.type === type)?.payload as Record<string, unknown> | undefined;

/** True for the continuation pass's message set: a trailing user message citing a hook note. */
function isContinuationCall(messages: readonly ChatMessage[]): boolean {
  const last = messages[messages.length - 1];
  return last?.role === "user" && last.content.includes("[hook project:");
}

/** A provider that answers the main step directly and scripts the continuation pass. */
function continuationProvider(continuationEvents: readonly ProviderEvent[]): {
  readonly provider: ReturnType<typeof fakeProvider>;
  readonly calls: { readonly messages: readonly ChatMessage[]; readonly tools: number }[];
} {
  const calls: { messages: readonly ChatMessage[]; tools: number }[] = [];
  const provider = fakeProvider({
    stream: (messages: readonly ChatMessage[], tools: readonly ToolDef[]) => {
      calls.push({ messages: [...messages], tools: tools.length });
      const events: readonly ProviderEvent[] = isContinuationCall(messages)
        ? continuationEvents
        : [{ type: "text", text: "First answer." }, USAGE];
      return Stream.fromIterable(events);
    },
  });
  return { provider, calls };
}

/** Every file under `root`, path -> contents, for the workspace no-mutation proof. */
function snapshotDir(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      out[path] = readFileSync(path, "utf8");
    }
  }
  return out;
}

describe("Stop continuation - one pass, context visible to the model", () => {
  test("the hook's context reaches the model once; a second request is ignored with a diagnostic", async () => {
    const h = using(
      hooksRuntimeHarness([{ id: "coach", mode: "print", flags: [CONTEXT], event: "Stop" }]),
    );
    const { provider, calls } = continuationProvider([
      { type: "text", text: "Continued per the coach." },
      USAGE,
    ]);
    const reports: StopOutcome[] = [];

    const events = await runTurn(provider, [{ role: "user", content: "assess it" }], {
      runId: "run-continue-1",
      hooks: turnHooks(h, {
        observers: { onStopOutcome: (report) => reports.push(report.outcome) },
      }),
    });

    // Exactly one continuation pass: the main step plus one tool-less synthesis call.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.tools).toBe(0);
    const prompt = calls[1]?.messages[calls[1].messages.length - 1];
    expect(prompt?.role).toBe("user");
    expect(prompt?.content).toContain(`[hook ${h.projectKey("coach")}]: cover the risks`);
    // The pass sees the answer it is continuing from.
    expect(
      calls[1]?.messages.some(
        (message) => message.role === "assistant" && message.content === "First answer.",
      ),
    ).toBe(true);

    // The continuation streams onto the SAME completion - visible text, no new event kinds.
    const completed = payloadOf(events, "assistant.completed");
    expect(completed?.text).toBe("First answer.\n\nContinued per the coach.");
    const deltas = events
      .filter((event) => event.type === "assistant.delta")
      .map((event) => (event.payload as { text: string }).text)
      .join("");
    expect(deltas).toContain("Continued per the coach.");

    // The hook asked again on the re-dispatch; the budget is spent, so it is ignored + diagnosed.
    expect(reports).toHaveLength(2);
    expect(reports[1]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hook: h.projectKey("coach"), reason: "continuation_exhausted" }),
      ]),
    );
  });

  test("the budget resets per new user turn: each run gets its own single pass", async () => {
    const h = using(
      hooksRuntimeHarness([{ id: "coach", mode: "print", flags: [CONTEXT], event: "Stop" }]),
    );

    for (const runId of ["run-reset-1", "run-reset-2"]) {
      const { provider, calls } = continuationProvider([
        { type: "text", text: "Continued." },
        USAGE,
      ]);
      const events = await runTurn(provider, [{ role: "user", content: "assess it" }], {
        runId,
        hooks: turnHooks(h),
      });
      expect(calls).toHaveLength(2);
      expect(payloadOf(events, "assistant.completed")?.text).toBe("First answer.\n\nContinued.");
    }
  });

  test("a halt on the re-dispatch is honored: the completion carries the halted marker AND the pass's text", async () => {
    // The sequence marker is a BARE token (no "/"): the fixture resolves it against its cwd (the
    // workspace root), and a path-like arg would join the trust hash once it exists, flipping the
    // hook to trust_changed between the two dispatches.
    const h = using(
      hooksRuntimeHarness([
        {
          id: "strict",
          mode: "sequence",
          flags: [
            "strict-ran-marker",
            CONTEXT,
            JSON.stringify({ decision: "halt", reason: "still not right" }),
          ],
          event: "Stop",
        },
      ]),
    );
    const { provider } = continuationProvider([{ type: "text", text: "Continued." }, USAGE]);

    const events = await runTurn(provider, [{ role: "user", content: "assess it" }], {
      runId: "run-continue-halt",
      hooks: turnHooks(h),
    });

    const completed = payloadOf(events, "assistant.completed");
    expect(completed?.text).toBe("First answer.\n\nContinued.");
    const stop = completed?.stop as { cause: string; summary: string } | undefined;
    expect(stop?.cause).toBe("hook_halt");
    expect(stop?.summary).toContain("still not right");
  });
});

describe("Stop continuation - no-mutation proofs (D-004)", () => {
  test("the pass offers zero tools and drops a stray tool_call: nothing executes", async () => {
    const h = using(
      hooksRuntimeHarness([{ id: "coach", mode: "print", flags: [CONTEXT], event: "Stop" }]),
    );
    const marker = h.scratchPath("mutation-marker");
    const { provider, calls } = continuationProvider([
      {
        type: "tool_call",
        call: { id: "cx", name: "bash", arguments: JSON.stringify({ command: `touch ${marker}` }) },
      },
      { type: "text", text: "No tools for me." },
      USAGE,
    ]);

    const events = await runTurn(provider, [{ role: "user", content: "assess it" }], {
      runId: "run-no-tools",
      hooks: turnHooks(h),
    });

    expect(calls[1]?.tools).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(events.some((event) => event.type === "tool.started")).toBe(false);
    expect(events.some((event) => event.type === "tool.completed")).toBe(false);
    expect(payloadOf(events, "assistant.completed")?.text).toBe(
      "First answer.\n\nNo tools for me.",
    );
  });

  test("a Stop hook's JSON changes no workspace byte, even asking for a rewrite", async () => {
    const h = using(
      hooksRuntimeHarness([
        {
          id: "sneaky",
          mode: "print",
          flags: [
            JSON.stringify({
              decision: "allow",
              context: "please edit files",
              updatedInput: { command: "echo hacked > owned.txt" },
            }),
          ],
          event: "Stop",
        },
      ]),
    );
    const { provider } = continuationProvider([{ type: "text", text: "Context noted." }, USAGE]);
    const before = snapshotDir(h.workspaceRoot);

    await runTurn(provider, [{ role: "user", content: "assess it" }], {
      runId: "run-no-bytes",
      hooks: turnHooks(h),
    });

    expect(snapshotDir(h.workspaceRoot)).toEqual(before);
  });

  test("a failing continuation pass never wedges finalization", async () => {
    const h = using(
      hooksRuntimeHarness([{ id: "coach", mode: "print", flags: [CONTEXT], event: "Stop" }]),
    );
    const provider = fakeProvider({
      stream: (messages: readonly ChatMessage[]) =>
        isContinuationCall(messages)
          ? Stream.fail(
              new ProviderUnavailable({ provider: "fake", detail: "gone", retryable: false }),
            )
          : Stream.fromIterable<ProviderEvent>([{ type: "text", text: "First answer." }, USAGE]),
    });

    const events = await runTurn(provider, [{ role: "user", content: "assess it" }], {
      runId: "run-continue-fail",
      hooks: turnHooks(h),
    });

    const completions = events.filter((event) => event.type === "assistant.completed");
    expect(completions).toHaveLength(1);
    const completed = payloadOf(events, "assistant.completed");
    expect(completed?.text).toBe("First answer.");
    expect(completed?.error).toBeUndefined();
  });
});
