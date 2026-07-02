import { existsSync, readFileSync } from "node:fs";
import type { TurnHooks } from "@host/agent/loop";
import type { PreToolUseOutcome } from "@host/hooks/runtime";
import type { TrevorEventInput } from "@trevor/session";
import { afterEach, describe, expect, test } from "vitest";
import { fakeProvider, runTurn, scriptedStep } from "../support/fake-provider";
import { type HooksRuntimeHarness, hooksRuntimeHarness } from "./runtime-fixture";

/**
 * PreToolUse at the REAL tool boundary (plan 25 M5): fake-provider turns through publishTurn ->
 * runAgent -> executeTool with a live hooks runtime over temp config roots. Proves the loop
 * builds the full payload, an allow leaves the tool result untouched, a deny withholds
 * execution and hands the model a clear denial, a halt terminates the turn with a visible stop,
 * and an unapproved hook is a diagnostic that never gates the tool (D-006, D-007).
 *
 * Responsible for: exercising the loop-side PreToolUse wiring end to end.
 * Not for: dispatch semantics in isolation - ./runtime.test.ts owns those.
 */

const DENY = JSON.stringify({ decision: "deny", reason: "not on my watch" });
const HALT = JSON.stringify({ decision: "halt", reason: "stop the line" });

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
    sessionId: "s-hooks",
    callerKind: "main",
    cwd: h.workspaceRoot,
    ...overrides,
  };
}

const payloadOf = (events: TrevorEventInput[], type: string) =>
  events.find((event) => event.type === type)?.payload as Record<string, unknown> | undefined;

async function runBashTurn(
  h: HooksRuntimeHarness,
  command: string,
  options: { readonly runId?: string; readonly hooks?: TurnHooks } = {},
): Promise<TrevorEventInput[]> {
  const provider = fakeProvider({
    step: scriptedStep([{ name: "bash", args: { command } }], "All done."),
  });
  return runTurn(provider, [{ role: "user", content: "run it" }], {
    runId: options.runId ?? "run-hooks-turn",
    hooks: options.hooks ?? turnHooks(h),
  });
}

describe("PreToolUse payload at the tool boundary", () => {
  test("the loop delivers session/run/turn ids, cwd, caller kind, tool name, input, and metadata", async () => {
    const h = using(
      hooksRuntimeHarness((scratch) => [
        { id: "rec", mode: "record", flags: [scratch("payload.json")] },
      ]),
    );

    await runBashTurn(h, "echo payload-proof", { runId: "run-payload-1" });

    const payload = JSON.parse(readFileSync(h.scratchPath("payload.json"), "utf8"));
    expect(payload).toEqual({
      event: "PreToolUse",
      sessionId: "s-hooks",
      runId: "run-payload-1",
      turnId: "run-payload-1",
      cwd: h.workspaceRoot,
      callerKind: "main",
      toolName: "bash",
      toolInput: { command: "echo payload-proof" },
      toolMetadata: { readOnly: false },
    });
  });
});

describe("PreToolUse allow - transparent pass-through", () => {
  test("the tool runs unchanged and the model sees its real result", async () => {
    const h = using(
      hooksRuntimeHarness([{ id: "ok", mode: "print", flags: ['{"decision":"allow"}'] }]),
    );

    const events = await runBashTurn(h, "echo allowed-through");

    const completed = payloadOf(events, "tool.completed");
    expect(completed?.result).toContain("allowed-through");
    expect(payloadOf(events, "assistant.completed")?.text).toBe("All done.");
  });
});

describe("PreToolUse deny - the tool is withheld, the model reads a clear denial", () => {
  test("the denied tool never executes and its result names the hook and reason", async () => {
    const h = using(hooksRuntimeHarness([{ id: "guard", mode: "print", flags: [DENY] }]));
    const marker = h.scratchPath("deny-marker");

    const events = await runBashTurn(h, `touch ${marker}`);

    expect(existsSync(marker)).toBe(false);
    const completed = payloadOf(events, "tool.completed");
    expect(completed?.result).toMatch(/^error: /);
    expect(completed?.result).toContain('denied by PreToolUse hook "project:guard"');
    expect(completed?.result).toContain("not on my watch");
    // The turn itself continues: the model reads the denial and still answers.
    expect(payloadOf(events, "assistant.completed")?.text).toBe("All done.");
  });
});

describe("PreToolUse halt - the turn stops with a visible reason", () => {
  test("the tool never executes and the completion carries the hook halt stop", async () => {
    const h = using(hooksRuntimeHarness([{ id: "stopper", mode: "print", flags: [HALT] }]));
    const marker = h.scratchPath("halt-marker");

    const events = await runBashTurn(h, `touch ${marker}`);

    expect(existsSync(marker)).toBe(false);
    const completed = payloadOf(events, "assistant.completed");
    const stop = completed?.stop as { cause: string; action: string; summary: string } | undefined;
    expect(stop?.cause).toBe("hook_halt");
    expect(stop?.action).toBe("paused");
    expect(stop?.summary).toContain("project:stopper");
    expect(stop?.summary).toContain("stop the line");
    // The halted call still gets a paired tool result so the transcript stays coherent.
    expect(payloadOf(events, "tool.completed")?.result).toContain("halted by PreToolUse hook");
  });
});

describe("PreToolUse trust gate at the boundary (D-006)", () => {
  test("an unapproved hook is a diagnostic only - the tool still runs", async () => {
    const h = using(
      hooksRuntimeHarness((scratch) => [
        { id: "rec", mode: "record", flags: [scratch("unapproved.json")], approved: false },
      ]),
    );
    const marker = h.scratchPath("unapproved-marker");
    const outcomes: PreToolUseOutcome[] = [];

    const events = await runBashTurn(h, `touch ${marker}`, {
      hooks: turnHooks(h, { onOutcome: (report) => outcomes.push(report.outcome) }),
    });

    expect(existsSync(marker)).toBe(true);
    expect(existsSync(h.scratchPath("unapproved.json"))).toBe(false);
    expect(payloadOf(events, "assistant.completed")?.text).toBe("All done.");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.decision).toBe("allow");
    expect(outcomes[0]?.diagnostics).toEqual([
      expect.objectContaining({ hook: "project:rec", reason: "unapproved" }),
    ]);
  });
});
