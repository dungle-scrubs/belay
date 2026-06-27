import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import type { SessionSummary } from "@trevor/session";
import { test } from "vitest";
import { effectiveActivity, SessionSidebar, visibleSessions } from "./session-sidebar";

/**
 * D-093 M1/M2/M3: the session navigation sidebar. Pins current-project scope, archived exclusion,
 * recency order, the selected state, row rendering, selection callback, accessibility, and the
 * running/queued/settled activity states (M3) - over production SessionSummary fixtures.
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
  assert.ok(
    container.querySelector('[aria-label="running"]'),
    "the running row shows the animated running indicator",
  );
});

test("rows show running, queued, and settled states distinctly (D-093 M3)", () => {
  const { container, getByText } = render(
    <SessionSidebar
      sessions={[
        summary({ sessionId: "run", title: "running one", activity: "running", host: "live" }),
        summary({ sessionId: "queue", title: "queued one", activity: "running", host: "live" }),
        summary({
          sessionId: "done",
          title: "settled one",
          activity: "settled",
          host: "live",
          updatedAt: ago(1000 * 60 * 10),
        }),
      ]}
      currentSessionId="run"
      currentProject="trevorV2"
      // The live send-queue owner marks "queue" as having work waiting behind its active turn.
      liveActivity={new Map([["queue", "queued"]])}
      onSelect={noop}
      nowMs={NOW}
    />,
  );
  const text = container.textContent ?? "";
  assert.equal(
    container.querySelectorAll('[aria-label="running"]').length,
    1,
    "only the running row shows the animated running indicator",
  );
  assert.ok(text.includes("queued"), "the live-queued row shows a queued label");
  // The settled row shows a relative time, not a live status word.
  assert.ok(getByText("10m ago"), "the settled row shows when it last settled");
  assert.ok(!text.includes("idle"), "settled is distinct from idle - no idle label");
  // The two active rows (running + queued) carry a green left activity bar; the settled row does not.
  assert.equal(
    container.querySelectorAll(".bg-smui-green").length,
    2,
    "running and queued rows both show the green active bar",
  );
});

test("activity stays visible for a session the user is NOT currently viewing (D-093 M3)", () => {
  // The viewed session is "cur"; a DIFFERENT session "bg" is running. Its activity must still show.
  const { getByText, container } = render(
    <SessionSidebar
      sessions={[
        summary({ sessionId: "cur", title: "viewing this", activity: "idle", host: "live" }),
        summary({ sessionId: "bg", title: "background run", activity: "running", host: "live" }),
      ]}
      currentSessionId="cur"
      currentProject="trevorV2"
      onSelect={noop}
      nowMs={NOW}
    />,
  );
  const bgRow = getByText("background run").closest("button");
  assert.ok(bgRow, "the non-current row renders");
  assert.ok(bgRow?.querySelector('[aria-label="running"]'), "its running indicator is visible");
  assert.ok(
    bgRow?.querySelector(".bg-smui-green"),
    "the green active bar shows on the non-current row",
  );
  // And it is not the selected row.
  assert.notEqual(bgRow?.getAttribute("aria-current"), "true");
  assert.ok(container.querySelector('[aria-current="true"]'), "a different row is selected");
});

test("effectiveActivity prefers a live override, else the durable activity (D-093 M3)", () => {
  const s = summary({ sessionId: "x", activity: "settled" });
  assert.equal(effectiveActivity(s), "settled", "no override -> durable activity");
  assert.equal(
    effectiveActivity(s, new Map([["x", "queued"]])),
    "queued",
    "a live override wins over the durable activity",
  );
  assert.equal(
    effectiveActivity(s, new Map([["other", "running"]])),
    "settled",
    "an override for a different session does not apply",
  );
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

test("switching is allowed even while the current session is running (D-093 M4)", () => {
  // Switching never stops the agent - the turn keeps running on the host - so a running current
  // session must NOT block selecting another session.
  const picked: string[] = [];
  const { getByText } = render(
    <SessionSidebar
      sessions={[
        summary({ sessionId: "cur", title: "current run", activity: "running", host: "live" }),
        summary({ sessionId: "s2", title: "switch target" }),
      ]}
      currentSessionId="cur"
      currentProject="trevorV2"
      onSelect={(id) => picked.push(id)}
      nowMs={NOW}
    />,
  );

  const target = getByText("switch target").closest("button") as HTMLButtonElement;
  assert.ok(target, "the other row renders");
  assert.ok(!target.disabled, "the other row is NOT disabled while the current session runs");
  fireEvent.click(target);
  assert.deepEqual(picked, ["s2"], "selecting another session fires even mid-run");
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

// --- D-093 M5: the dashboard-icon collapse affordance + keyboard accessibility ---

test("the collapse toggle renders only when the app wires onToggle, and fires it", () => {
  let collapsed = 0;
  const { getByLabelText } = render(
    <SessionSidebar
      sessions={[summary({ sessionId: "cur" })]}
      currentSessionId="cur"
      currentProject="trevorV2"
      onSelect={noop}
      onToggle={() => (collapsed += 1)}
      nowMs={NOW}
    />,
  );
  fireEvent.click(getByLabelText("Collapse sessions sidebar"));
  assert.equal(collapsed, 1, "the header toggle collapses the sidebar");
});

test("the sidebar stays a static header in standalone/Storybook use (no toggle without onToggle)", () => {
  const { queryByLabelText } = render(
    <SessionSidebar
      sessions={[summary({ sessionId: "cur" })]}
      currentSessionId="cur"
      currentProject="trevorV2"
      onSelect={noop}
      nowMs={NOW}
    />,
  );
  assert.equal(
    queryByLabelText("Collapse sessions sidebar"),
    null,
    "no collapse affordance when the app does not own an open/closed state",
  );
});

test("session rows are keyboard-focusable buttons that select on activation", () => {
  let selected = "";
  const { getByText } = render(
    <SessionSidebar
      sessions={[
        summary({ sessionId: "cur", title: "current" }),
        summary({ sessionId: "s2", title: "other" }),
      ]}
      currentSessionId="cur"
      currentProject="trevorV2"
      onSelect={(id) => (selected = id)}
      nowMs={NOW}
    />,
  );
  const row = getByText("other").closest("button") as HTMLButtonElement;
  row.focus();
  assert.equal(document.activeElement, row, "a row can take keyboard focus");
  // Native button: a keyboard Enter/Space activates the same onClick a pointer does.
  fireEvent.click(row);
  assert.equal(selected, "s2", "activating the focused row selects that session");
});
