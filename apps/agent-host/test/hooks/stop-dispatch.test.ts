import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { type HooksRuntimeHarness, hooksRuntimeHarness, stopPayload } from "./runtime-fixture";

/**
 * Stop dispatch integration tests (plan 25 M7): `dispatchStop` driven end to end over real temp
 * config roots and the real fixture child, mirroring ./runtime.test.ts for PreToolUse - payload
 * delivery on stdin, allow pass-through (explicit and implicit silent-success), the first halt
 * short-circuiting later hooks in config order, a stray "deny" normalizing to halt (Stop has no
 * per-tool deny), the approval gate (D-006), non-blocking failure diagnostics (D-007), bounded
 * context accumulation, and the event filter (a PreToolUse hook never fires for Stop).
 *
 * Responsible for: exercising createHooksRuntime.dispatchStop over ./runtime-fixture.
 * Not for: the turn-finalization wiring - ./stop-turn.test.ts owns that.
 */

const HALT = JSON.stringify({ decision: "halt", reason: "not good enough" });
const DENY = JSON.stringify({ decision: "deny", reason: "spoke the wrong verb" });

let harness: HooksRuntimeHarness | undefined;

function using(built: HooksRuntimeHarness): HooksRuntimeHarness {
  harness = built;
  return built;
}

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

describe("dispatchStop - payload and allow pass-through", () => {
  test("the full Stop payload arrives on the hook's stdin as JSON", async () => {
    const h = using(
      hooksRuntimeHarness((scratch) => [
        { id: "rec", mode: "record", flags: [scratch("stop-payload.json")], event: "Stop" },
      ]),
    );

    const payload = stopPayload({
      sessionId: "s-77",
      runId: "run-77",
      turnId: "run-77",
      cwd: h.workspaceRoot,
      terminalReason: "context_pressure",
      finalText: "Everything is wired.",
      toolSummary: [
        { tool: "bash", count: 3 },
        { tool: "read", count: 1, files: ["notes.md"] },
      ],
    });
    const outcome = await h.runtime.dispatchStop(payload);

    expect(outcome.decision).toBe("allow");
    expect(outcome.diagnostics).toEqual([]);
    expect(JSON.parse(readFileSync(h.scratchPath("stop-payload.json"), "utf8"))).toEqual(payload);
  });

  test("a silent exit-0 hook with no stdout is an implicit allow", async () => {
    const h = using(
      hooksRuntimeHarness([{ id: "quiet", mode: "print", flags: [""], event: "Stop" }]),
    );
    const outcome = await h.runtime.dispatchStop(stopPayload());
    expect(outcome.decision).toBe("allow");
    expect(outcome.diagnostics).toEqual([]);
  });

  test("no configured Stop hooks means a transparent allow", async () => {
    const h = using(hooksRuntimeHarness([]));
    const outcome = await h.runtime.dispatchStop(stopPayload());
    expect(outcome.decision).toBe("allow");
    expect(outcome.contexts).toEqual([]);
    expect(outcome.diagnostics).toEqual([]);
  });

  test("a PreToolUse hook is never dispatched for Stop", async () => {
    const h = using(
      hooksRuntimeHarness((scratch) => [
        { id: "pre", mode: "record", flags: [scratch("wrong-event.json")], event: "PreToolUse" },
      ]),
    );
    const outcome = await h.runtime.dispatchStop(stopPayload());
    expect(outcome.decision).toBe("allow");
    expect(outcome.diagnostics).toEqual([]);
    expect(existsSync(h.scratchPath("wrong-event.json"))).toBe(false);
  });
});

describe("dispatchStop - blocking decisions and config order", () => {
  test("the first halt short-circuits: later hooks in config order never execute", async () => {
    const h = using(
      hooksRuntimeHarness((scratch) => [
        { id: "gate", mode: "print", flags: [HALT], event: "Stop" },
        { id: "after", mode: "record", flags: [scratch("after.json")], event: "Stop" },
      ]),
    );

    const outcome = await h.runtime.dispatchStop(stopPayload());

    expect(outcome.decision).toBe("halt");
    expect(outcome.hook).toBe("project:gate");
    expect(outcome.reason).toBe("not good enough");
    expect(existsSync(h.scratchPath("after.json"))).toBe(false);
  });

  test('a stray "deny" normalizes to halt - Stop has exactly one blocking semantic', async () => {
    const h = using(
      hooksRuntimeHarness([{ id: "denier", mode: "print", flags: [DENY], event: "Stop" }]),
    );
    const outcome = await h.runtime.dispatchStop(stopPayload());
    expect(outcome.decision).toBe("halt");
    expect(outcome.hook).toBe("project:denier");
    expect(outcome.reason).toBe("spoke the wrong verb");
  });
});

describe("dispatchStop - the approval gate (D-006)", () => {
  test("an unapproved hook never executes and surfaces only a diagnostic", async () => {
    const h = using(
      hooksRuntimeHarness((scratch) => [
        {
          id: "rec",
          mode: "record",
          flags: [scratch("unapproved.json")],
          event: "Stop",
          approved: false,
        },
      ]),
    );

    const outcome = await h.runtime.dispatchStop(stopPayload());

    expect(outcome.decision).toBe("allow");
    expect(outcome.diagnostics).toEqual([
      expect.objectContaining({ hook: "project:rec", reason: "unapproved" }),
    ]);
    expect(existsSync(h.scratchPath("unapproved.json"))).toBe(false);
  });
});

describe("dispatchStop - bounded context and non-blocking failures (D-007)", () => {
  test("context from allow hooks accumulates in config order with attribution", async () => {
    const h = using(
      hooksRuntimeHarness([
        {
          id: "one",
          mode: "print",
          flags: ['{"decision":"allow","context":"first note"}'],
          event: "Stop",
        },
        {
          id: "two",
          mode: "print",
          flags: ['{"decision":"allow","context":"second note"}'],
          event: "Stop",
        },
      ]),
    );

    const outcome = await h.runtime.dispatchStop(stopPayload());

    expect(outcome.decision).toBe("allow");
    expect(outcome.contexts).toEqual([
      { hook: "project:one", context: "first note" },
      { hook: "project:two", context: "second note" },
    ]);
  });

  test("a Stop decision's updatedInput is ignored - the outcome carries no rewrite surface", async () => {
    const h = using(
      hooksRuntimeHarness([
        {
          id: "rewriter",
          mode: "print",
          flags: ['{"decision":"allow","updatedInput":{"command":"rm -rf /"}}'],
          event: "Stop",
        },
      ]),
    );

    const outcome = await h.runtime.dispatchStop(stopPayload());

    expect(outcome.decision).toBe("allow");
    expect(outcome.diagnostics).toEqual([]);
    expect("updatedInput" in outcome).toBe(false);
  });

  test("a failing hook is a diagnostic; the dispatch still allows", async () => {
    const h = using(
      hooksRuntimeHarness([{ id: "broken", mode: "fail", flags: ["boom", "3"], event: "Stop" }]),
    );

    const outcome = await h.runtime.dispatchStop(stopPayload());

    expect(outcome.decision).toBe("allow");
    expect(outcome.diagnostics).toEqual([
      expect.objectContaining({ hook: "project:broken", reason: "command_failed" }),
    ]);
  });
});
