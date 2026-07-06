import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionSummary } from "./inventory";
import { byRecency, sessionsForProject } from "./inventory-display";

/**
 * The one owner of "what shows in a project's navigation" (C-01): active-or-archived, project-scoped,
 * newest-first - and, crucially, tangents excluded from the active view so a consumer can't leak them
 * into the sidebar/resume list. Pins the composite the web sidebar and the SDK selector both delegate to.
 */

// A local summary fixture: the session package must not import @trevor/test-kit (it depends on session,
// so that would cycle into the core), so the shared sessionSummary factory is off-limits here.
function sessionSummary(over: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return {
    title: "t",
    cwd: null,
    workspace: null,
    project: "trevor",
    branch: null,
    git: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    eventCount: 0,
    host: "none",
    activity: "idle",
    archived: false,
    deleted: false,
    forkedFrom: null,
    tangentOf: null,
    ...over,
  };
}

const tangent = {
  parentSessionId: "root",
  sourceMessageId: "m",
  quote: "q",
  label: null,
  createdAt: "x",
};

test("sessionsForProject scopes to the project, excludes archived + deleted + tangents, newest first", () => {
  const list = [
    sessionSummary({ sessionId: "a", project: "trevor", updatedAt: "2026-06-01T00:00:00.000Z" }),
    sessionSummary({ sessionId: "b", project: "trevor", updatedAt: "2026-06-02T00:00:00.000Z" }),
    sessionSummary({ sessionId: "filed", project: "trevor", archived: true }),
    sessionSummary({ sessionId: "gone", project: "trevor", deleted: true }),
    sessionSummary({ sessionId: "side", project: "trevor", tangentOf: tangent }),
    sessionSummary({ sessionId: "other", project: "elsewhere" }),
  ];
  assert.deepEqual(
    sessionsForProject(list, "trevor").map((s) => s.sessionId),
    ["b", "a"],
    "archived/deleted/tangent/other-project all excluded; recency desc",
  );
});

test("sessionsForProject with archived:true lists the archived (non-deleted) sessions instead", () => {
  const list = [
    sessionSummary({ sessionId: "a", project: "trevor" }),
    sessionSummary({ sessionId: "filed", project: "trevor", archived: true }),
    sessionSummary({ sessionId: "filed-gone", project: "trevor", archived: true, deleted: true }),
  ];
  assert.deepEqual(
    sessionsForProject(list, "trevor", { archived: true }).map((s) => s.sessionId),
    ["filed"],
  );
});

test("sessionsForProject with a null project lists across every project", () => {
  const list = [
    sessionSummary({ sessionId: "a", project: "trevor" }),
    sessionSummary({ sessionId: "b", project: "elsewhere" }),
  ];
  assert.deepEqual(
    sessionsForProject(list, null)
      .map((s) => s.sessionId)
      .sort(),
    ["a", "b"],
  );
});

test("byRecency orders most-recent updatedAt first", () => {
  const older = sessionSummary({ sessionId: "old", updatedAt: "2026-06-01T00:00:00.000Z" });
  const newer = sessionSummary({ sessionId: "new", updatedAt: "2026-06-09T00:00:00.000Z" });
  assert.deepEqual(
    [older, newer].sort(byRecency).map((s) => s.sessionId),
    ["new", "old"],
  );
});
