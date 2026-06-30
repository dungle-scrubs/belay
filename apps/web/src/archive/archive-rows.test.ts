import type { SessionSummary } from "@trevor/session";
import { describe, expect, test } from "vitest";
import {
  archiveProtectedReason,
  buildArchiveRows,
  isArchiveRowDeletable,
  toArchiveRow,
} from "./archive-rows";

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
    ...over,
  };
}

describe("buildArchiveRows", () => {
  test("includes archived (not deleted) sessions, newest activity first", () => {
    const rows = buildArchiveRows([
      summary({ sessionId: "old", updatedAt: "2026-06-01T00:00:00.000Z" }),
      summary({ sessionId: "new", updatedAt: "2026-06-09T00:00:00.000Z" }),
    ]);
    expect(rows.map((r) => r.sessionId)).toEqual(["new", "old"]);
  });

  test("excludes non-archived and soft-deleted sessions", () => {
    const rows = buildArchiveRows([
      summary({ sessionId: "active", archived: false }),
      summary({ sessionId: "soft-deleted", archived: true, deleted: true }),
      summary({ sessionId: "archived" }),
    ]);
    expect(rows.map((r) => r.sessionId)).toEqual(["archived"]);
  });

  test("carries the management metadata onto the row", () => {
    const [row] = buildArchiveRows([
      summary({ sessionId: "s1", title: "Refactor auth", project: "app", eventCount: 42 }),
    ]);
    expect(row).toMatchObject({
      sessionId: "s1",
      title: "Refactor auth",
      project: "app",
      eventCount: 42,
    });
  });
});

describe("delete eligibility (protectedReason)", () => {
  test("a settled, host-less archived session is deletable", () => {
    const row = toArchiveRow(summary({ host: "none", activity: "settled" }));
    expect(row.protectedReason).toBeNull();
    expect(isArchiveRowDeletable(row)).toBe(true);
  });

  test("a live host protects the session from delete", () => {
    expect(archiveProtectedReason(summary({ host: "live" }))).toMatch(/host is live/);
    expect(isArchiveRowDeletable(toArchiveRow(summary({ host: "live" })))).toBe(false);
  });

  test("an active (running/queued) turn protects the session from delete", () => {
    expect(archiveProtectedReason(summary({ activity: "running" }))).toMatch(/turn is active/);
    expect(archiveProtectedReason(summary({ activity: "queued" }))).toMatch(/turn is active/);
  });

  test("a stale host (not live) does not protect", () => {
    expect(archiveProtectedReason(summary({ host: "stale", activity: "settled" }))).toBeNull();
  });
});
