import type { TrevorEventInput } from "@belay/session";
import type { TurnHooks } from "@host/agent/loop";
import { afterEach, describe, expect, test } from "vitest";
import { fakeProvider, runTurn, scriptedStep } from "../support/fake-provider";
import { type HooksRuntimeHarness, hooksRuntimeHarness } from "./runtime-fixture";

/**
 * Plan 25 M9: `hook.decision` events at the REAL turn seam - fake-provider turns through
 * publishTurn with a live hooks runtime over temp config roots, collecting what the turn
 * publishes. Proves the wrapper wired inside publishTurn emits visible events for a deny, a
 * Stop halt, and trust diagnostics (deduped per turn), while a plain-allow turn publishes NO
 * hook events at all (allow is log-only) - so an unhooked transcript is byte-identical.
 *
 * Responsible for: exercising the publishTurn hook.decision emission end to end.
 * Not for: the pure outcome -> event fold - src/agent/hook-events.test.ts owns that.
 */

const DENY = JSON.stringify({ decision: "deny", reason: "bash is off limits" });
const HALT = JSON.stringify({ decision: "halt", reason: "review before shipping" });

let harness: HooksRuntimeHarness | undefined;

function using(built: HooksRuntimeHarness): HooksRuntimeHarness {
  harness = built;
  return built;
}

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

function turnHooks(h: HooksRuntimeHarness): TurnHooks {
  return {
    dispatchPreToolUse: h.runtime.dispatchPreToolUse,
    dispatchStop: h.runtime.dispatchStop,
    hasHooks: h.runtime.hasHooks,
    identity: { sessionId: "s-hook-events", callerKind: "main", cwd: h.workspaceRoot },
  };
}

const hookDecisions = (events: readonly TrevorEventInput[]) =>
  events
    .filter((event) => event.type === "hook.decision")
    .map((event) => event.payload as Record<string, unknown>);

const twoCallProvider = () =>
  fakeProvider({
    step: scriptedStep(
      [
        { name: "bash", args: { command: "echo one" } },
        { name: "bash", args: { command: "echo two" } },
      ],
      "All done.",
    ),
  });

describe("hook.decision emission from the turn pipeline", () => {
  test("an allow-only turn publishes zero hook events", async () => {
    const h = using(
      hooksRuntimeHarness([
        { id: "ok", mode: "print", flags: ['{"decision":"allow"}'] },
        { id: "fin", mode: "print", flags: ['{"decision":"allow"}'], event: "Stop" },
      ]),
    );

    const events = await runTurn(twoCallProvider(), [{ role: "user", content: "go" }], {
      runId: "run-hd-allow",
      hooks: turnHooks(h),
    });

    expect(hookDecisions(events)).toEqual([]);
  });

  test("a deny publishes a visible hook.decision carrying the run, hook, tool, and reason", async () => {
    const h = using(hooksRuntimeHarness([{ id: "guard", mode: "print", flags: [DENY] }]));

    const events = await runTurn(twoCallProvider(), [{ role: "user", content: "go" }], {
      runId: "run-hd-deny",
      hooks: turnHooks(h),
    });

    const decisions = hookDecisions(events);
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0]).toEqual({
      runId: "run-hd-deny",
      hookId: h.projectKey("guard"),
      event: "PreToolUse",
      decision: "deny",
      toolName: "bash",
      reason: "bash is off limits",
    });
  });

  test("a Stop halt publishes its hook.decision alongside the halted completion", async () => {
    const h = using(
      hooksRuntimeHarness([{ id: "review", mode: "print", flags: [HALT], event: "Stop" }]),
    );

    const events = await runTurn(twoCallProvider(), [{ role: "user", content: "go" }], {
      runId: "run-hd-halt",
      hooks: turnHooks(h),
    });

    expect(hookDecisions(events)).toEqual([
      {
        runId: "run-hd-halt",
        hookId: h.projectKey("review"),
        event: "Stop",
        decision: "halt",
        reason: "review before shipping",
      },
    ]);
    // The event is ordered before the terminal completion, so replay renders it in place.
    const types = events.map((event) => event.type);
    expect(types.indexOf("hook.decision")).toBeLessThan(types.indexOf("assistant.completed"));
  });

  test("an unapproved hook's diagnostic is deduped to one event per turn", async () => {
    const h = using(
      hooksRuntimeHarness([{ id: "new", mode: "print", flags: [DENY], approved: false }]),
    );

    const events = await runTurn(twoCallProvider(), [{ role: "user", content: "go" }], {
      runId: "run-hd-unapproved",
      hooks: turnHooks(h),
    });

    // Two gated tool calls, one visible unapproved row - not one per call.
    expect(hookDecisions(events)).toEqual([
      expect.objectContaining({
        hookId: h.projectKey("new"),
        event: "PreToolUse",
        decision: "unapproved",
      }),
    ]);
  });
});
