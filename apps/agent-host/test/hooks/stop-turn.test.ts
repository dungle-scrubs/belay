import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TurnHooks } from "@host/agent/loop";
import { publishTurn } from "@host/agent/turn";
import { type ProviderEvent, ProviderUnavailable } from "@host/providers";
import type { TrevorEventInput } from "@trevor/session";
import { Effect, Fiber, Stream } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import { collectingEmit, fakeProvider, runTurn, scriptedStep } from "../support/fake-provider";
import { type HooksRuntimeHarness, hooksRuntimeHarness } from "./runtime-fixture";

/**
 * Stop at the REAL turn-finalization seam (plan 25 M7): fake-provider turns through publishTurn
 * with a live hooks runtime over temp config roots. Proves the turn builds the full Stop payload
 * (terminal reason, final text, compact tool summary), an allow finalizes byte-identically, a
 * halt puts a visible hook-halt stop on the terminal completion without wedging the run, and the
 * dispatch rule: Stop fires only for a genuine terminal assistant result (the success exit) -
 * never for a cancelled turn or a provider-failed turn.
 *
 * Responsible for: exercising the publishTurn Stop wiring end to end.
 * Not for: dispatch semantics in isolation - ./stop-dispatch.test.ts owns those.
 */

const HALT = JSON.stringify({ decision: "halt", reason: "ship it tomorrow" });

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
    identity: { sessionId: "s-stop", callerKind: "main", cwd: h.workspaceRoot },
    ...overrides,
  };
}

const payloadOf = (events: TrevorEventInput[], type: string) =>
  events.find((event) => event.type === type)?.payload as Record<string, unknown> | undefined;

describe("Stop payload at the finalization seam", () => {
  test("the turn delivers ids, cwd, terminal reason, final text, and the compact tool summary", async () => {
    const h = using(
      hooksRuntimeHarness((scratch) => [
        { id: "rec", mode: "record", flags: [scratch("stop.json")], event: "Stop" },
      ]),
    );
    const notes = join(h.workspaceRoot, "notes.md");
    writeFileSync(notes, "remember the lockfile\n");
    const provider = fakeProvider({
      step: scriptedStep(
        [
          { name: "bash", args: { command: "echo one" } },
          { name: "bash", args: { command: "echo two" } },
          { name: "read", args: { path: notes } },
        ],
        "All done.",
      ),
    });

    await runTurn(provider, [{ role: "user", content: "run it" }], {
      runId: "run-stop-1",
      hooks: turnHooks(h),
    });

    const payload = JSON.parse(readFileSync(h.scratchPath("stop.json"), "utf8"));
    expect(payload).toEqual({
      event: "Stop",
      sessionId: "s-stop",
      runId: "run-stop-1",
      turnId: "run-stop-1",
      cwd: h.workspaceRoot,
      terminalReason: "completed",
      finalText: "All done.",
      toolSummary: [
        { tool: "bash", count: 2 },
        { tool: "read", count: 1, files: [notes] },
      ],
    });
  });
});

describe("Stop allow - transparent finalization", () => {
  test("the completion is byte-identical to a turn with no hooks at all", async () => {
    const h = using(
      hooksRuntimeHarness([
        { id: "ok", mode: "print", flags: ['{"decision":"allow"}'], event: "Stop" },
      ]),
    );
    const history = [{ role: "user" as const, content: "run it" }];
    const provider = () =>
      fakeProvider({
        step: scriptedStep([{ name: "bash", args: { command: "echo same" } }], "All done."),
      });

    const gated = await runTurn(provider(), history, {
      runId: "run-stop-allow",
      hooks: turnHooks(h),
    });
    const bare = await runTurn(provider(), history, { runId: "run-stop-allow" });

    expect(JSON.stringify(payloadOf(gated, "assistant.completed"))).toBe(
      JSON.stringify(payloadOf(bare, "assistant.completed")),
    );
  });
});

describe("Stop halt - the completion carries a visible halted-by-hook reason", () => {
  test("the turn still ends: one terminal completion, final text intact, hook-halt stop attached", async () => {
    const h = using(
      hooksRuntimeHarness([{ id: "gate", mode: "print", flags: [HALT], event: "Stop" }]),
    );
    const provider = fakeProvider({
      step: scriptedStep([{ name: "bash", args: { command: "echo fine" } }], "All done."),
    });

    const events = await runTurn(provider, [{ role: "user", content: "run it" }], {
      runId: "run-stop-halt",
      hooks: turnHooks(h),
    });

    const completions = events.filter((event) => event.type === "assistant.completed");
    expect(completions).toHaveLength(1);
    const completed = payloadOf(events, "assistant.completed");
    expect(completed?.text).toBe("All done.");
    const stop = completed?.stop as { cause: string; action: string; summary: string } | undefined;
    expect(stop?.cause).toBe("hook_halt");
    expect(stop?.summary).toContain(`Stop hook "${h.projectKey("gate")}"`);
    expect(stop?.summary).toContain("ship it tomorrow");
  });
});

describe("Stop payload toolSummary counts EXECUTED tools only (25 simplify C4)", () => {
  test("a hook-denied call never appears in the Stop payload's tool summary", async () => {
    const DENY_BASH = JSON.stringify({ decision: "deny", reason: "no shell today" });
    const h = using(
      hooksRuntimeHarness((scratch) => [
        { id: "guard", mode: "print", flags: [DENY_BASH] },
        { id: "rec", mode: "record", flags: [scratch("summary.json")], event: "Stop" },
      ]),
    );
    const provider = fakeProvider({
      step: scriptedStep([{ name: "bash", args: { command: "echo denied" } }], "All done."),
    });

    await runTurn(provider, [{ role: "user", content: "run it" }], {
      runId: "run-stop-denied",
      hooks: turnHooks(h),
    });

    // The denied bash call produced a paired tool result but never RAN, so the Stop payload's
    // accounting of "what the turn executed" is empty.
    const payload = JSON.parse(readFileSync(h.scratchPath("summary.json"), "utf8"));
    expect(payload.toolSummary).toEqual([]);
  });
});

describe("Stop halt - reason redaction is parse-time (25 simplify S2)", () => {
  test("a halt reason carrying an env-style secret reaches the stop summary redacted", async () => {
    const leakyHalt = JSON.stringify({
      decision: "halt",
      reason: "halting: CI_SECRET=halt-secret-value must not ship",
    });
    const h = using(
      hooksRuntimeHarness([{ id: "gate", mode: "print", flags: [leakyHalt], event: "Stop" }]),
    );
    const provider = fakeProvider({
      step: scriptedStep([{ name: "bash", args: { command: "echo fine" } }], "All done."),
    });

    const events = await runTurn(provider, [{ role: "user", content: "run it" }], {
      runId: "run-stop-redact",
      hooks: turnHooks(h),
    });

    const completed = payloadOf(events, "assistant.completed");
    const stop = completed?.stop as { cause: string; summary: string } | undefined;
    expect(stop?.cause).toBe("hook_halt");
    expect(stop?.summary).not.toContain("halt-secret-value");
    expect(stop?.summary).toContain("CI_SECRET=");
  });
});

describe("Stop gate defect backstop (25 simplify C1)", () => {
  test("a hooks binding whose dispatchStop rejects still publishes the terminal completion", async () => {
    const h = using(hooksRuntimeHarness([]));
    const provider = fakeProvider({
      step: scriptedStep([{ name: "bash", args: { command: "echo fine" } }], "All done."),
    });

    const events = await runTurn(provider, [{ role: "user", content: "run it" }], {
      runId: "run-stop-defect",
      hooks: turnHooks(h, {
        dispatchStop: () => Promise.reject(new Error("discovery layer exploded")),
        // Claim a Stop hook exists so the gate actually dispatches the broken binding.
        hasHooks: (event) => event === "Stop",
      }),
    });

    const completions = events.filter((event) => event.type === "assistant.completed");
    expect(completions).toHaveLength(1);
    expect(payloadOf(events, "assistant.completed")?.text).toBe("All done.");
  });
});

describe("Stop dispatch rule - genuine terminal completions only", () => {
  test("a cancelled turn never dispatches Stop", async () => {
    const h = using(
      hooksRuntimeHarness((scratch) => [
        { id: "rec", mode: "record", flags: [scratch("cancelled.json")], event: "Stop" },
      ]),
    );
    const hanging = fakeProvider({
      stream: () =>
        Stream.concat(
          Stream.fromIterable<ProviderEvent>([{ type: "text", text: "x".repeat(60) }]),
          Stream.fromEffect(Effect.never),
        ),
    });
    const { layer, events } = collectingEmit();
    const fiber = Effect.runFork(
      publishTurn(hanging, [{ role: "user", content: "hang" }], {
        runId: "run-stop-cancel",
        hooks: turnHooks(h),
      }).pipe(Effect.provide(layer)),
    );
    const deadline = Date.now() + 2000;
    while (!events.some((event) => event.type === "assistant.delta")) {
      if (Date.now() > deadline) throw new Error("turn never streamed a delta");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(payloadOf(events, "assistant.completed")?.cancelled).toBe(true);
    expect(existsSync(h.scratchPath("cancelled.json"))).toBe(false);
  });

  test("a provider-failed turn never dispatches Stop", async () => {
    const h = using(
      hooksRuntimeHarness((scratch) => [
        { id: "rec", mode: "record", flags: [scratch("failed.json")], event: "Stop" },
      ]),
    );
    const failing = fakeProvider({
      stream: () =>
        Stream.fail(
          new ProviderUnavailable({ provider: "fake", detail: "socket gone", retryable: false }),
        ),
    });

    const events = await runTurn(failing, [{ role: "user", content: "fail" }], {
      runId: "run-stop-fail",
      hooks: turnHooks(h),
    });

    expect(payloadOf(events, "assistant.completed")?.error).toBeTruthy();
    expect(existsSync(h.scratchPath("failed.json"))).toBe(false);
  });
});
