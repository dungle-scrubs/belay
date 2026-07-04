import { describe, expect, test } from "vitest";
import type { SessionSummary } from "./inventory";
import { permanentDeleteEligibility } from "./session-delete";

// Local fixture (the eligibility happy path is an archived session): @trevor/session is the core
// protocol package, so its tests don't depend on @trevor/test-kit (which depends on session) - that
// would be a cycle into the core. The web archive tests, which may depend on test-kit, share its
// `sessionSummary` instead.
function summary(over: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: "s",
    title: "A session",
    cwd: "~/dev/x",
    workspace: "~/dev/x",
    project: "x",
    branch: "main",
    git: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    eventCount: 3,
    host: "none",
    activity: "settled",
    archived: true,
    deleted: false,
    forkedFrom: null,
    tangentOf: null,
    ...over,
  };
}

describe("permanentDeleteEligibility", () => {
  test("a settled, host-less archived session is eligible", () => {
    expect(permanentDeleteEligibility(summary({}))).toEqual({ ok: true });
  });

  test("a missing session is not-found", () => {
    expect(permanentDeleteEligibility(null)).toEqual({
      ok: false,
      reason: "not-found",
      detail: expect.stringContaining("not found"),
    });
  });

  test("an un-archived session is rejected (only archived sessions are deletable)", () => {
    const verdict = permanentDeleteEligibility(summary({ archived: false }));
    expect(verdict).toMatchObject({ ok: false, reason: "not-archived" });
  });

  test("a live host protects the session", () => {
    const verdict = permanentDeleteEligibility(summary({ host: "live" }));
    expect(verdict).toMatchObject({ ok: false, reason: "protected" });
    if (!verdict.ok) {
      expect(verdict.detail).toMatch(/host is live/);
    }
  });

  test("a running or queued turn protects the session", () => {
    expect(permanentDeleteEligibility(summary({ activity: "running" }))).toMatchObject({
      ok: false,
      reason: "protected",
    });
    expect(permanentDeleteEligibility(summary({ activity: "queued" }))).toMatchObject({
      ok: false,
      reason: "protected",
    });
  });

  test("a stale host on a settled session stays eligible", () => {
    expect(permanentDeleteEligibility(summary({ host: "stale", activity: "settled" }))).toEqual({
      ok: true,
    });
  });

  test("archived gate precedes the active-turn gate (an unarchived running session reads not-archived)", () => {
    expect(
      permanentDeleteEligibility(summary({ archived: false, activity: "running" })),
    ).toMatchObject({ ok: false, reason: "not-archived" });
  });
});
