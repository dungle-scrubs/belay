import type { WorktreeSummary } from "@trevor/session";
import { sessionSummary } from "@trevor/test-kit";
import { describe, expect, test } from "vitest";
import {
  buildProjectSidebar,
  buildWorktreeSessionMap,
  filterProjectSidebar,
  type ProjectSidebarRecord,
  SESSION_CAP,
} from "./project-sidebar-model";

/**
 * Plan 58 M5 (RED): the pure project-sidebar read model. Groups active sessions under projects from
 * registry records (plus transient projects forced by active sessions), orders by recency, and
 * supports search. Pure over injected records + summaries; no live wiring (that's M6).
 *
 * Fixtures use the shared `sessionSummary` kit helper and minimal `ProjectSidebarRecord` partials
 * (structurally compatible with `ProjectRegistryRecord`).
 */

/** A project record fixture: the few fields the read model consumes from a registry record. */
function project(over: Partial<ProjectSidebarRecord> & { path: string }): ProjectSidebarRecord {
  return {
    displayPath: over.path,
    displayName: over.path.split("/").pop() ?? over.path,
    collapsed: false,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

/** First group of a build, asserting there is exactly one (the common single-project case). */
function sole<T>(groups: readonly T[]): T {
  expect(groups).toHaveLength(1);
  // length asserted above; the index is safe, but avoid `!` (biome noNonNullAssertion).
  const head = groups[0];
  if (head === undefined) {
    throw new Error("sole: empty groups");
  }
  return head;
}

describe("buildProjectSidebar", () => {
  test("groups sessions under their project by projectPath", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/trevor" })],
      [
        sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor" }),
        sessionSummary({ sessionId: "s2", projectPath: "/dev/trevor" }),
      ],
    );
    const group = sole(groups);
    expect(group.key).toBe("/dev/trevor");
    expect(group.sessions.map((s) => s.summary.sessionId)).toEqual(["s1", "s2"]);
    expect(group.isTransient).toBe(false);
    expect(group.activeCount).toBe(2);
  });

  test("falls back to workspace then cwd when projectPath is null", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/ws" })],
      [
        sessionSummary({ sessionId: "ws", projectPath: null, workspace: "/dev/ws", cwd: null }),
        sessionSummary({ sessionId: "cwd", projectPath: null, workspace: null, cwd: "/dev/cwd" }),
      ],
    );
    const keys = groups.map((g) => g.key);
    expect(keys).toContain("/dev/ws");
    expect(keys).toContain("/dev/cwd");
    const wsGroup = groups.find((g) => g.key === "/dev/ws");
    expect(wsGroup?.sessions.map((s) => s.summary.sessionId)).toEqual(["ws"]);
  });

  test("transient project appears when a session has a projectPath but no registry record", () => {
    const groups = buildProjectSidebar(
      [],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/ghost" })],
    );
    const group = sole(groups);
    expect(group.key).toBe("/dev/ghost");
    expect(group.isTransient).toBe(true);
    expect(group.displayName).toBe("ghost");
    expect(group.collapsed).toBe(false);
  });

  test("registry-only project (no sessions) appears with empty sessions array", () => {
    const groups = buildProjectSidebar([project({ path: "/dev/empty" })], []);
    const group = sole(groups);
    expect(group.key).toBe("/dev/empty");
    expect(group.sessions).toEqual([]);
    expect(group.activeCount).toBe(0);
  });

  test("archived and deleted sessions are excluded", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/trevor" })],
      [
        sessionSummary({ sessionId: "live", projectPath: "/dev/trevor" }),
        sessionSummary({ sessionId: "arch", projectPath: "/dev/trevor", archived: true }),
        sessionSummary({ sessionId: "gone", projectPath: "/dev/trevor", deleted: true }),
      ],
    );
    const group = sole(groups);
    expect(group.sessions.map((s) => s.summary.sessionId)).toEqual(["live"]);
  });

  test("a project with only archived sessions shows as an empty project", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/trevor" })],
      [sessionSummary({ sessionId: "arch", projectPath: "/dev/trevor", archived: true })],
    );
    const group = sole(groups);
    expect(group.sessions).toEqual([]);
  });

  test("tangent sessions are excluded", () => {
    const tangentOf = {
      parentSessionId: "parent",
      sourceMessageId: "m1",
      quote: "q",
      label: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    } as const;
    const groups = buildProjectSidebar(
      [project({ path: "/dev/trevor" })],
      [
        sessionSummary({ sessionId: "normal", projectPath: "/dev/trevor" }),
        sessionSummary({ sessionId: "tan", projectPath: "/dev/trevor", tangentOf }),
      ],
    );
    const group = sole(groups);
    expect(group.sessions.map((s) => s.summary.sessionId)).toEqual(["normal"]);
  });

  test("projects ordered by creation order (oldest first), NOT activity", () => {
    const groups = buildProjectSidebar(
      [
        project({
          path: "/dev/older-created",
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-02T00:00:00.000Z",
        }),
        project({
          path: "/dev/newer-created",
          createdAt: "2026-06-05T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z",
        }),
      ],
      [],
    );
    // Creation order wins even though /dev/newer-created has the more recent activity
    // (activity-order would put /dev/newer-created first).
    expect(groups.map((g) => g.key)).toEqual(["/dev/older-created", "/dev/newer-created"]);
  });

  test("projects with equal createdAt keep a stable order (tiebreaker by key, no swapping)", () => {
    const groups = buildProjectSidebar(
      [
        project({ path: "/dev/zebra", createdAt: "2026-06-01T00:00:00.000Z" }),
        project({ path: "/dev/alpha", createdAt: "2026-06-01T00:00:00.000Z" }),
        project({ path: "/dev/mango", createdAt: "2026-06-01T00:00:00.000Z" }),
      ],
      [],
    );
    // Same createdAt -> deterministic order by key, so equal-created projects never swap renders.
    expect(groups.map((g) => g.key)).toEqual(["/dev/alpha", "/dev/mango", "/dev/zebra"]);
  });

  test("sessions within a project sorted by updatedAt descending", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/trevor" })],
      [
        sessionSummary({
          sessionId: "old",
          projectPath: "/dev/trevor",
          updatedAt: "2026-06-01T00:00:00.000Z",
        }),
        sessionSummary({
          sessionId: "new",
          projectPath: "/dev/trevor",
          updatedAt: "2026-06-09T00:00:00.000Z",
        }),
        sessionSummary({
          sessionId: "mid",
          projectPath: "/dev/trevor",
          updatedAt: "2026-06-05T00:00:00.000Z",
        }),
      ],
    );
    const group = sole(groups);
    expect(group.sessions.map((s) => s.summary.sessionId)).toEqual(["new", "mid", "old"]);
  });

  test("updatedAt is the max of registry updatedAt and session updatedAt", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/trevor", updatedAt: "2026-06-10T00:00:00.000Z" })],
      [
        sessionSummary({
          sessionId: "s1",
          projectPath: "/dev/trevor",
          updatedAt: "2026-06-05T00:00:00.000Z",
        }),
      ],
    );
    const group = sole(groups);
    expect(group.updatedAt).toBe("2026-06-10T00:00:00.000Z");
  });

  test("collapsed state comes from the registry record", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/trevor", collapsed: true })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor" })],
    );
    const group = sole(groups);
    expect(group.collapsed).toBe(true);
  });

  test("duplicate basenames: both projects appear, each with its full displayPath", () => {
    const groups = buildProjectSidebar(
      [
        project({ path: "/work/trevor", displayPath: "/work/trevor" }),
        project({ path: "/home/trevor", displayPath: "/home/trevor" }),
      ],
      [
        sessionSummary({ sessionId: "s1", projectPath: "/work/trevor" }),
        sessionSummary({ sessionId: "s2", projectPath: "/home/trevor" }),
      ],
    );
    expect(groups).toHaveLength(2);
    const names = groups.map((g) => g.displayName);
    expect(names).toEqual(["trevor", "trevor"]);
    const paths = groups.map((g) => g.displayPath).sort();
    expect(paths).toEqual(["/home/trevor", "/work/trevor"]);
  });

  test("displayName from a user-renamed registry record is preserved", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/trevor", displayName: "My Project" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor" })],
    );
    const group = sole(groups);
    expect(group.displayName).toBe("My Project");
  });

  test("SESSION_CAP is 5", () => {
    expect(SESSION_CAP).toBe(5);
  });
});

describe("filterProjectSidebar", () => {
  const baseGroups = buildProjectSidebar(
    [project({ path: "/dev/trevor" }), project({ path: "/dev/other" })],
    [
      sessionSummary({ sessionId: "s1", title: "fix the lease", projectPath: "/dev/trevor" }),
      sessionSummary({ sessionId: "s2", title: "unrelated work", projectPath: "/dev/trevor" }),
      sessionSummary({ sessionId: "s3", title: "build sidebar", projectPath: "/dev/other" }),
    ],
  );

  test("filters by project name (case-insensitive)", () => {
    const filtered = filterProjectSidebar(baseGroups, "trevor");
    expect(filtered.map((g) => g.key)).toEqual(["/dev/trevor"]);
  });

  test("filters by project path", () => {
    const filtered = filterProjectSidebar(baseGroups, "/dev/other");
    expect(filtered.map((g) => g.key)).toEqual(["/dev/other"]);
  });

  test("filters by session title", () => {
    const filtered = filterProjectSidebar(baseGroups, "lease");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.key).toBe("/dev/trevor");
    expect(filtered[0]?.sessions.map((s) => s.summary.sessionId)).toEqual(["s1"]);
  });

  test("auto-expands matching projects (sets collapsed false without mutating source)", () => {
    const collapsedGroups = buildProjectSidebar(
      [project({ path: "/dev/trevor", collapsed: true })],
      [sessionSummary({ sessionId: "s1", title: "sidebar work", projectPath: "/dev/trevor" })],
    );
    expect(collapsedGroups[0]?.collapsed).toBe(true);
    const filtered = filterProjectSidebar(collapsedGroups, "sidebar");
    expect(filtered[0]?.collapsed).toBe(false);
    // source is not mutated
    expect(collapsedGroups[0]?.collapsed).toBe(true);
  });

  test("empty query returns all groups unchanged", () => {
    const filtered = filterProjectSidebar(baseGroups, "");
    expect(filtered).toHaveLength(2);
  });

  test("returns only groups with a matching session OR a matching project name/path", () => {
    const filtered = filterProjectSidebar(baseGroups, "trevor");
    // /dev/trevor matches by name; its sessions are not filtered out because the project matched
    expect(filtered[0]?.sessions.map((s) => s.summary.sessionId)).toEqual(["s1", "s2"]);
  });

  test("a project whose name matches but no session matches keeps all its sessions", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/matchme" })],
      [
        sessionSummary({ sessionId: "s1", title: "zzz", projectPath: "/dev/matchme" }),
        sessionSummary({ sessionId: "s2", title: "yyy", projectPath: "/dev/matchme" }),
      ],
    );
    const filtered = filterProjectSidebar(groups, "matchme");
    expect(filtered[0]?.sessions.map((s) => s.summary.sessionId)).toEqual(["s1", "s2"]);
  });

  test("query matching nothing returns an empty array", () => {
    const filtered = filterProjectSidebar(baseGroups, "zzzznomatch");
    expect(filtered).toEqual([]);
  });
});

/** WorktreeSummary fixture for the scoped sessionId join (plan 58.2). */
function wt(over: Partial<WorktreeSummary> & { sessionId: string }): WorktreeSummary {
  return {
    id: over.id ?? over.sessionId,
    baseRepo: "/dev/trevor",
    baseRepoName: "trevor",
    branch: "feat/x",
    path: "~/dev/.worktrees/trevor/feat-x",
    dirty: false,
    ahead: 0,
    behind: 0,
    conflict: false,
    detached: false,
    current: false,
    baseline: false,
    missing: false,
    ...over,
  };
}

describe("plan 58.2 worktree session join", () => {
  test("a worktree session with projectPath equal to the base repo groups under the base project offline", () => {
    // No host online = no worktrees snapshot. Grouping still uses the durable projectPath.
    const groups = buildProjectSidebar(
      [project({ path: "/dev/trevor" })],
      [
        sessionSummary({
          sessionId: "wt-s1",
          projectPath: "/dev/trevor",
          workspace: "/Users/kevin/dev/.worktrees/trevor/feat-x",
          cwd: "/Users/kevin/dev/.worktrees/trevor/feat-x",
        }),
      ],
    );
    const group = sole(groups);
    expect(group.key).toBe("/dev/trevor");
    expect(group.sessions.map((s) => s.summary.sessionId)).toEqual(["wt-s1"]);
    expect(group.sessions[0]?.worktree).toBeNull();
  });

  test("buildWorktreeSessionMap keys on sessionId and excludes baseline === true", () => {
    const map = buildWorktreeSessionMap([
      wt({ sessionId: "baseline", baseline: true, branch: "main", path: "/dev/trevor" }),
      wt({ sessionId: "wt-s1", baseline: false }),
    ]);
    expect(map.has("baseline")).toBe(false);
    expect(map.get("wt-s1")?.sessionId).toBe("wt-s1");
    expect(map.size).toBe(1);
  });

  test("no path inference: worktree-looking paths get no badge when sessionId is absent from the snapshot", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/trevor" })],
      [
        sessionSummary({
          sessionId: "orphan-looking",
          projectPath: "/dev/trevor",
          workspace: "/Users/kevin/dev/.worktrees/trevor/orphan",
          cwd: "/Users/kevin/dev/.worktrees/trevor/orphan",
        }),
        sessionSummary({ sessionId: "wt-s1", projectPath: "/dev/trevor" }),
      ],
      [
        // Snapshot only knows about wt-s1; orphan-looking is not in it.
        wt({ sessionId: "wt-s1" }),
        // Baseline never badges, even if its sessionId matched a base-checkout session.
        wt({ sessionId: "main-checkout", baseline: true }),
      ],
    );
    const group = sole(groups);
    const byId = new Map(group.sessions.map((r) => [r.summary.sessionId, r]));
    expect(byId.get("orphan-looking")?.worktree).toBeNull();
    expect(byId.get("wt-s1")?.worktree?.sessionId).toBe("wt-s1");
  });

  test("current-host-scoped snapshot badges only listed sessionIds, not an all-project index", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/trevor" }), project({ path: "/dev/other" })],
      [
        sessionSummary({ sessionId: "trevor-wt", projectPath: "/dev/trevor" }),
        sessionSummary({ sessionId: "other-wt", projectPath: "/dev/other" }),
      ],
      // Only the currently viewed host (trevor) announced a worktree.
      [wt({ sessionId: "trevor-wt" })],
    );
    const trevor = groups.find((g) => g.key === "/dev/trevor");
    const other = groups.find((g) => g.key === "/dev/other");
    expect(trevor?.sessions[0]?.worktree?.sessionId).toBe("trevor-wt");
    expect(other?.sessions[0]?.worktree).toBeNull();
  });
});
