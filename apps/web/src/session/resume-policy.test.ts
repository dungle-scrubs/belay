import type { SessionSummary } from "@belay/session";
import { expect, test } from "vitest";
import { calendarDayStatus, launchRootForSession, resumeActionForSession } from "./resume-policy";

const NOW = new Date(2026, 6, 9, 0, 5).getTime();

function summary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    activity: "settled",
    archived: false,
    branch: null,
    createdAt: "2026-07-08T12:00:00.000Z",
    cwd: null,
    deleted: false,
    eventCount: 10,
    forkedFrom: null,
    git: null,
    host: "stale",
    project: "belay",
    projectPath: "/repo/project",
    sessionId: "s1",
    tangentOf: null,
    worktree: null,
    title: "Session",
    updatedAt: new Date(2026, 6, 9, 0, 1).toISOString(),
    workspace: null,
    ...overrides,
  };
}

test("calendarDayStatus uses local calendar days instead of a 24-hour duration", () => {
  expect(calendarDayStatus(new Date(2026, 6, 9, 0, 1).toISOString(), NOW)).toBe("today");
  expect(calendarDayStatus(new Date(2026, 6, 8, 23, 50).toISOString(), NOW)).toBe("older");
});

test("resume policy hides live sessions and auto-starts today's no-host sessions", () => {
  expect(resumeActionForSession(summary({ host: "live" }), NOW)).toEqual({
    kind: "hidden",
    reason: "live",
  });
  expect(resumeActionForSession(summary({ host: "none" }), NOW)).toEqual({
    kind: "auto-start",
    root: "/repo/project",
    sessionId: "s1",
  });
});

test("resume policy requires manual resume for older no-host sessions", () => {
  const updatedAt = new Date(2026, 6, 8, 23, 50).toISOString();
  expect(resumeActionForSession(summary({ updatedAt }), NOW)).toEqual({
    kind: "manual",
    root: "/repo/project",
    sessionId: "s1",
    updatedAt,
  });
});

test("resume policy reports unlaunchable sessions when no root is known", () => {
  const updatedAt = new Date(2026, 6, 9, 0, 1).toISOString();
  expect(
    resumeActionForSession(
      summary({ cwd: null, projectPath: null, updatedAt, workspace: null }),
      NOW,
    ),
  ).toEqual({
    kind: "unlaunchable",
    sessionId: "s1",
    updatedAt,
  });
});

test("launchRootForSession prefers projectPath, then workspace, then cwd", () => {
  expect(
    launchRootForSession(summary({ cwd: "/cwd", projectPath: "/project", workspace: "/ws" })),
  ).toBe("/project");
  expect(launchRootForSession(summary({ cwd: "/cwd", projectPath: null, workspace: "/ws" }))).toBe(
    "/ws",
  );
  expect(launchRootForSession(summary({ cwd: "/cwd", projectPath: null, workspace: null }))).toBe(
    "/cwd",
  );
});
