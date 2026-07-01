import { describe, expect, it } from "vitest";
import {
  classifyLoopCommand,
  LOOP_COMMAND_NAMES,
  LOOP_CONTROL_VERBS,
  LOOP_FAMILY,
  LOOP_PROTOCOL_ACTIONS,
  LOOP_RUNNER_ALIASES,
  loopGrammar,
  loopSnapshotToInventoryRow,
} from "./index";

/**
 * The shared, host-authoritative `/loop` command-family CONTRACT (plan 17, M1): discovery names, runner
 * aliases, examples, and the protocol-action metadata a headless client discovers without any helper UI.
 */

describe("loop command family contract (M1)", () => {
  it("is discoverable by /loop and /loops with a menu summary and guide description", () => {
    expect(LOOP_FAMILY.id).toBe("loop");
    expect(LOOP_FAMILY.names).toEqual(["/loop", "/loops"]);
    expect(LOOP_COMMAND_NAMES).toEqual(["/loop", "/loops"]);
    expect(LOOP_FAMILY.summary.length).toBeGreaterThan(0);
    expect(LOOP_FAMILY.description.toLowerCase()).toContain("bound");
  });

  it("maps the runner aliases users type (current/session/background/process)", () => {
    expect(LOOP_RUNNER_ALIASES.current).toBe("current_session_prompt");
    expect(LOOP_RUNNER_ALIASES.session).toBe("current_session_prompt");
    expect(LOOP_RUNNER_ALIASES.background).toBe("background_agent");
    expect(LOOP_RUNNER_ALIASES.process).toBe("process");
  });

  it("lists runnable examples that each start with a loop name", () => {
    expect(LOOP_FAMILY.examples.length).toBeGreaterThan(0);
    for (const example of LOOP_FAMILY.examples) {
      expect(example.text.startsWith("/loop")).toBe(true);
      expect(example.note.length).toBeGreaterThan(0);
    }
  });

  it("exposes the lifecycle protocol actions (create/list + every control verb)", () => {
    expect(LOOP_PROTOCOL_ACTIONS).toContain("create");
    expect(LOOP_PROTOCOL_ACTIONS).toContain("list");
    for (const verb of LOOP_CONTROL_VERBS) {
      expect(LOOP_PROTOCOL_ACTIONS).toContain(verb);
    }
    // The descriptor carries the same action metadata for headless discovery.
    expect(LOOP_FAMILY.protocolActions).toEqual([...LOOP_PROTOCOL_ACTIONS]);
  });

  it("derives the legend from the keyword list in guide order (no second list to drift)", () => {
    const grammar = loopGrammar();
    expect(grammar.legend).toEqual(LOOP_FAMILY.keywords.map((keyword) => keyword.keyword));
    expect(grammar.controlVerbs.has("stop")).toBe(true);
  });
});

describe("loop snapshot inventory projection", () => {
  it("maps running snapshots to client inventory rows", () => {
    const row = loopSnapshotToInventoryRow({
      completed: 3,
      durability: "durable",
      loopId: "loop_1",
      max: 10,
      nextRun: 1_800_000_000_000,
      runner: "background_agent",
      status: "running",
      summary: "triage issues",
    });

    expect(row).toMatchObject({
      agentBacked: true,
      controls: ["pause", "stop", "run-now", "delete"],
      durability: "durable",
      loopId: "loop_1",
      progress: { completed: 3, max: 10 },
      runner: "background_agent",
      status: "running",
      summary: "triage issues",
    });
    expect(row?.nextRun).toBe(1_800_000_000_000);
  });

  it("maps pending to draft, process to not agent-backed, and deleted to null", () => {
    expect(
      loopSnapshotToInventoryRow({
        completed: 0,
        durability: "session",
        loopId: "loop_pending",
        runner: "process",
        status: "pending",
        summary: "curl health",
      }),
    ).toMatchObject({
      agentBacked: false,
      controls: [],
      status: "draft",
    });

    expect(
      loopSnapshotToInventoryRow({
        completed: 0,
        durability: "session",
        loopId: "loop_deleted",
        runner: "current_session_prompt",
        status: "deleted",
        summary: "old loop",
      }),
    ).toBeNull();
  });
});

describe("loop command classification for routing (M1)", () => {
  it("classifies a creation line as create", () => {
    expect(classifyLoopCommand('/loop max 5 do "run tests"').action).toBe("create");
  });

  it("classifies a list subcommand as list", () => {
    expect(classifyLoopCommand("/loop list").action).toBe("list");
  });

  it("classifies a BARE /loops (plural, no subcommand) as list", () => {
    expect(classifyLoopCommand("/loops").action).toBe("list");
    // Bare /loop (singular) still opens the builder (create), not list.
    expect(classifyLoopCommand("/loop").action).toBe("create");
  });

  it("classifies each control verb and extracts the target loop id", () => {
    for (const verb of LOOP_CONTROL_VERBS) {
      const routed = classifyLoopCommand(`/loop ${verb} loop_42`);
      expect(routed.action).toBe(verb);
      expect(routed.loopId).toBe("loop_42");
    }
  });

  it("reports a control verb with no id (id omitted) so the host can prompt for usage", () => {
    const routed = classifyLoopCommand("/loop stop");
    expect(routed.action).toBe("stop");
    expect(routed.loopId).toBeUndefined();
  });

  it("classifies a non-loop input as invalid", () => {
    expect(classifyLoopCommand("/help").action).toBe("invalid");
    expect(classifyLoopCommand("just text").action).toBe("invalid");
  });
});
