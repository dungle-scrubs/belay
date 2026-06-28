import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SessionSummary } from "@trevor/session";
import { test, vi } from "vitest";
import { ResumeModal } from "./ResumeModal";
import type { ResumeContext } from "./resume-rows";

const NOW = Date.parse("2026-06-26T12:00:00.000Z");

const summary = (over: Partial<SessionSummary>): SessionSummary => ({
  sessionId: "s",
  title: "a session",
  cwd: "~/dev/trevorV2",
  workspace: "~/dev/trevorV2",
  project: "trevorV2",
  branch: "main",
  git: null,
  createdAt: "2026-06-25T12:00:00.000Z",
  updatedAt: "2026-06-26T11:00:00.000Z",
  eventCount: 10,
  host: "live",
  activity: "idle",
  archived: false,
  deleted: false,
  ...over,
});

const sessions: SessionSummary[] = [
  summary({ sessionId: "cur", title: "current work" }),
  summary({ sessionId: "other", title: "other session" }),
  // A session in a DIFFERENT project: the chooser is cwd-scoped, so it must not appear.
  summary({ sessionId: "op", title: "opchain audit", project: "opchain", host: "stale" }),
];

function renderModal(over: Partial<React.ComponentProps<typeof ResumeModal>> = {}) {
  const onResume = vi.fn();
  const onOpenChange = vi.fn();
  const context: ResumeContext = {
    currentSessionId: "cur",
    currentProject: "trevorV2",
    busy: false,
    nowMs: NOW,
  };
  render(
    <ResumeModal
      open
      onOpenChange={onOpenChange}
      sessions={sessions}
      context={context}
      onResume={onResume}
      {...over}
    />,
  );
  return { onResume, onOpenChange };
}

test("shows only the current working directory's sessions, not other projects", () => {
  renderModal();
  assert.ok(screen.getByText("current work"));
  assert.ok(screen.getByText("other session"));
  // A different-project session is excluded by the cwd scoping.
  assert.equal(screen.queryByText("opchain audit"), null);
});

test("selecting another session resumes it and closes the modal", () => {
  const { onResume, onOpenChange } = renderModal();
  fireEvent.click(screen.getByText("other session"));
  assert.deepEqual(onResume.mock.calls, [["other"]]);
  assert.deepEqual(onOpenChange.mock.calls.at(-1), [false]);
});

test("the current session row is disabled and never resumes", () => {
  const { onResume } = renderModal();
  fireEvent.click(screen.getByText("current work"));
  assert.equal(onResume.mock.calls.length, 0);
  assert.ok(screen.getByText("current session"));
});

test("while busy, switching to another session is blocked", () => {
  const { onResume } = renderModal({
    context: { currentSessionId: "cur", currentProject: "trevorV2", busy: true, nowMs: NOW },
  });
  fireEvent.click(screen.getByText("other session"));
  assert.equal(onResume.mock.calls.length, 0);
  assert.ok(screen.getAllByText("finish the current run first").length >= 1);
});

test("an empty inventory shows the no-sessions empty state", () => {
  renderModal({ sessions: [] });
  assert.ok(screen.getByText("No sessions found"));
});

test("an inventory error shows the error, not an empty list", () => {
  renderModal({ sessions: [], error: "inventory unreachable" });
  assert.ok(screen.getByText("inventory unreachable"));
});

test("loading shows a loading state", () => {
  renderModal({ sessions: [], loading: true });
  assert.ok(screen.getByText("Loading…"));
});
