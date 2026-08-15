import type { SessionSummary } from "@belay/session";
import { sessionSummary } from "@belay/test-kit";
import { describe, expect, it } from "vitest";
import { buildLineage } from "./lineage";

/** A session summary with a fork lineage. */
function s(id: string, forkedFrom?: { parentSessionId: string; forkSeq: number }): SessionSummary {
  return sessionSummary({ sessionId: id, title: id, ...(forkedFrom ? { forkedFrom } : {}) });
}

describe("buildLineage (M3)", () => {
  it("returns null when the current session is not in the inventory", () => {
    expect(buildLineage([s("a")], "missing")).toBeNull();
  });

  it("gives a root session empty ancestors + its direct children", () => {
    const sessions = [
      s("root"),
      s("child1", { parentSessionId: "root", forkSeq: 4 }),
      s("child2", { parentSessionId: "root", forkSeq: 8 }),
      s("other"),
    ];
    const lineage = buildLineage(sessions, "root");
    expect(lineage?.ancestors).toEqual([]);
    expect(lineage?.current.sessionId).toBe("root");
    expect(lineage?.children.map((c) => c.sessionId)).toEqual(["child1", "child2"]);
    // A child carries the parent seq it branched at.
    expect(lineage?.children[1]?.forkSeq).toBe(8);
  });

  it("walks the ancestor chain root-first up to the immediate parent", () => {
    const sessions = [
      s("root"),
      s("mid", { parentSessionId: "root", forkSeq: 3 }),
      s("leaf", { parentSessionId: "mid", forkSeq: 6 }),
    ];
    const lineage = buildLineage(sessions, "leaf");
    expect(lineage?.ancestors.map((a) => a.sessionId)).toEqual(["root", "mid"]);
    expect(lineage?.current.sessionId).toBe("leaf");
    expect(lineage?.current.forkSeq).toBe(6);
    expect(lineage?.children).toEqual([]);
  });

  it("records a missing parent as a non-navigable stub instead of dropping the link", () => {
    const lineage = buildLineage([s("child", { parentSessionId: "gone", forkSeq: 2 })], "child");
    expect(lineage?.ancestors).toEqual([{ sessionId: "gone", title: "gone", missing: true }]);
  });

  it("stops the ancestor walk on a cycle instead of looping forever", () => {
    // A pathological self-referential link must not hang the navigator.
    const sessions = [s("loop", { parentSessionId: "loop", forkSeq: 1 })];
    const lineage = buildLineage(sessions, "loop");
    expect(lineage?.ancestors).toEqual([]);
    expect(lineage?.current.sessionId).toBe("loop");
  });
});
