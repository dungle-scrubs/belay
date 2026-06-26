import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import type { SessionSummary } from "@trevor/session";
import { test } from "vitest";
import { SessionSidebar, visibleSessions } from "./session-sidebar";

/**
 * D-093 M1/M2: the session navigation sidebar. Pins current-project scope, archived exclusion,
 * recency order, the selected state, row rendering, selection callback, and accessibility - over
 * production SessionSummary fixtures.
 */

const NOW = Date.parse("2026-06-27T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function summary(over: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return {
    title: `session ${over.sessionId}`,
    cwd: "~/dev/trevorV2",
    workspace: "~/dev/trevorV2",
    project: "trevorV2",
    branch: "main",
    git: null,
    createdAt: ago(1000 * 60 * 60),
    updatedAt: ago(1000 * 60 * 30),
    eventCount: 1,
    host: "none",
    activity: "idle",
    archived: false,
    ...over,
  };
}

const noop = () => {};

test("visibleSessions scopes to the current project, excludes archived, newest first", () => {
  const list = [
    summary({ sessionId: "a", updatedAt: ago(1000 * 60 * 60) }),
    summary({ sessionId: "b", updatedAt: ago(1000 * 60 * 5) }),
    summary({ sessionId: "filed", archived: true }),
    summary({ sessionId: "other", project: "otherRepo" }),
  ];
  assert.deepEqual(
    visibleSessions(list, "trevorV2").map((s) => s.sessionId),
    ["b", "a"],
    "archived + other-project excluded; recency desc",
  );
});

test("cross-project sessions never appear even when more recent", () => {
  const list = [
    summary({ sessionId: "mine", updatedAt: ago(1000 * 60 * 60) }),
    summary({ sessionId: "newer-other", project: "otherRepo", updatedAt: ago(1000) }),
  ];
  assert.deepEqual(
    visibleSessions(list, "trevorV2").map((s) => s.sessionId),
    ["mine"],
  );
});

test("renders rows with title + branch and marks the current session selected", () => {
  const { container, getByText } = render(
    <SessionSidebar
      sessions={[
        summary({ sessionId: "cur", title: "the work", branch: "feat/x" }),
        summary({ sessionId: "s2", title: "other work" }),
      ]}
      currentSessionId="cur"
      currentProject="trevorV2"
      onSelect={noop}
      nowMs={NOW}
    />,
  );
  assert.ok(getByText("the work"), "the title renders");
  assert.ok(getByText("feat/x"), "the branch renders");
  const selected = container.querySelector('[aria-current="true"]');
  assert.ok(
    (selected?.textContent ?? "").includes("the work"),
    "the current session is marked selected",
  );
});

test("a running session shows a running indicator", () => {
  const { container } = render(
    <SessionSidebar
      sessions={[summary({ sessionId: "cur", activity: "running", host: "live" })]}
      currentSessionId="cur"
      currentProject="trevorV2"
      onSelect={noop}
      nowMs={NOW}
    />,
  );
  assert.ok((container.textContent ?? "").includes("running"));
});

test("clicking a row selects that session", () => {
  const picked: string[] = [];
  const { getByText } = render(
    <SessionSidebar
      sessions={[
        summary({ sessionId: "cur", title: "current" }),
        summary({ sessionId: "s2", title: "switch to me" }),
      ]}
      currentSessionId="cur"
      currentProject="trevorV2"
      onSelect={(id) => picked.push(id)}
      nowMs={NOW}
    />,
  );
  fireEvent.click(getByText("switch to me"));
  assert.deepEqual(picked, ["s2"]);
});

test("the normal sidebar exposes no stop/kill/archive controls (D-094 M4)", () => {
  const { container } = render(
    <SessionSidebar
      sessions={[
        summary({ sessionId: "cur", title: "current", activity: "running", host: "live" }),
        summary({ sessionId: "s2", title: "other" }),
        summary({ sessionId: "filed", title: "filed", archived: true }),
      ]}
      currentSessionId="cur"
      currentProject="trevorV2"
      onSelect={noop}
      nowMs={NOW}
    />,
  );

  // The only interactive controls are the one-per-visible-session select rows (the archived "filed"
  // session is excluded), so there are exactly two buttons and nothing else to click - no per-row
  // stop/kill/archive affordances. Escape/cancel stays the active-work control; lifecycle operations
  // live in the CLI and (later) a gated debug surface, never the everyday sidebar.
  const buttons = [...container.querySelectorAll("button")];
  assert.equal(buttons.length, 2, "only the per-session select rows are interactive");

  // Lifecycle verbs never appear as visible text or accessible labels in the everyday surface.
  const labels = [...container.querySelectorAll("[aria-label],[title]")].flatMap((el) => [
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("title") ?? "",
  ]);
  const haystack = [container.textContent ?? "", ...labels].join(" ").toLowerCase();
  for (const verb of ["stop", "kill", "archive", "unarchive"]) {
    assert.ok(!haystack.includes(verb), `no "${verb}" control in the normal sidebar`);
  }
});

test("an empty list shows a project-scoped empty state with an accessible nav label", () => {
  const { container } = render(
    <SessionSidebar
      sessions={[]}
      currentSessionId="none"
      currentProject="trevorV2"
      onSelect={noop}
      nowMs={NOW}
    />,
  );
  assert.ok(container.querySelector('[aria-label="sessions"]'), "the nav is labelled");
  assert.ok(
    (container.textContent ?? "").includes("No sessions for trevorV2"),
    "the empty state names the project",
  );
});
