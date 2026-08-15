import type { WorktreeSummary } from "@belay/session";
import { sessionSummary } from "@belay/test-kit";
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
      [project({ path: "/dev/belay" })],
      [
        sessionSummary({ sessionId: "s1", projectPath: "/dev/belay" }),
        sessionSummary({ sessionId: "s2", projectPath: "/dev/belay" }),
      ],
    );
    const group = sole(groups);
    expect(group.key).toBe("/dev/belay");
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
      [project({ path: "/dev/belay" })],
      [
        sessionSummary({ sessionId: "live", projectPath: "/dev/belay" }),
        sessionSummary({ sessionId: "arch", projectPath: "/dev/belay", archived: true }),
        sessionSummary({ sessionId: "gone", projectPath: "/dev/belay", deleted: true }),
      ],
    );
    const group = sole(groups);
    expect(group.sessions.map((s) => s.summary.sessionId)).toEqual(["live"]);
  });

  test("a project with only archived sessions shows as an empty project", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/belay" })],
      [sessionSummary({ sessionId: "arch", projectPath: "/dev/belay", archived: true })],
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
      [project({ path: "/dev/belay" })],
      [
        sessionSummary({ sessionId: "normal", projectPath: "/dev/belay" }),
        sessionSummary({ sessionId: "tan", projectPath: "/dev/belay", tangentOf }),
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

  test("sessions within a project sorted by createdAt descending (newest first)", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/belay" })],
      [
        sessionSummary({
          sessionId: "old",
          projectPath: "/dev/belay",
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        }),
        sessionSummary({
          sessionId: "new",
          projectPath: "/dev/belay",
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z",
        }),
        sessionSummary({
          sessionId: "mid",
          projectPath: "/dev/belay",
          createdAt: "2026-06-05T00:00:00.000Z",
          updatedAt: "2026-06-05T00:00:00.000Z",
        }),
      ],
    );
    const group = sole(groups);
    expect(group.sessions.map((s) => s.summary.sessionId)).toEqual(["new", "mid", "old"]);
  });

  test("sessions keep a stable order when a sibling's activity changes (concurrent worktrees)", () => {
    // Two sessions in the same project. `base` is older (createdAt) but has MORE recent activity
    // (updatedAt) than `worktree`. Activity-ordering would put `base` first; creation-ordering keeps
    // `worktree` (newer creation) first regardless of activity churn.
    const base = {
      sessionId: "base",
      projectPath: "/dev/belay",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const worktree = {
      sessionId: "wt",
      projectPath: "/dev/belay",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };

    // Initial render.
    const g1 = sole(
      buildProjectSidebar(
        [project({ path: "/dev/belay" })],
        [sessionSummary(base), sessionSummary(worktree)],
      ),
    );
    expect(g1.sessions.map((s) => s.summary.sessionId)).toEqual(["wt", "base"]);

    // `base` now has newer activity than `wt` (e.g. its host re-announced). The order must NOT flip.
    const g2 = sole(
      buildProjectSidebar(
        [project({ path: "/dev/belay" })],
        [
          sessionSummary({ ...base, updatedAt: "2026-07-01T00:00:00.000Z" }),
          sessionSummary(worktree),
        ],
      ),
    );
    expect(g2.sessions.map((s) => s.summary.sessionId)).toEqual(["wt", "base"]);
  });

  test("updatedAt is the max of registry updatedAt and session updatedAt", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/belay", updatedAt: "2026-06-10T00:00:00.000Z" })],
      [
        sessionSummary({
          sessionId: "s1",
          projectPath: "/dev/belay",
          updatedAt: "2026-06-05T00:00:00.000Z",
        }),
      ],
    );
    const group = sole(groups);
    expect(group.updatedAt).toBe("2026-06-10T00:00:00.000Z");
  });

  test("collapsed state comes from the registry record", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/belay", collapsed: true })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/belay" })],
    );
    const group = sole(groups);
    expect(group.collapsed).toBe(true);
  });

  test("duplicate basenames: both projects appear, each with its full displayPath", () => {
    const groups = buildProjectSidebar(
      [
        project({ path: "/work/belay", displayPath: "/work/belay" }),
        project({ path: "/home/belay", displayPath: "/home/belay" }),
      ],
      [
        sessionSummary({ sessionId: "s1", projectPath: "/work/belay" }),
        sessionSummary({ sessionId: "s2", projectPath: "/home/belay" }),
      ],
    );
    expect(groups).toHaveLength(2);
    const names = groups.map((g) => g.displayName);
    expect(names).toEqual(["belay", "belay"]);
    const paths = groups.map((g) => g.displayPath).sort();
    expect(paths).toEqual(["/home/belay", "/work/belay"]);
  });

  test("displayName from a user-renamed registry record is preserved", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/belay", displayName: "My Project" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/belay" })],
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
    [project({ path: "/dev/belay" }), project({ path: "/dev/other" })],
    [
      sessionSummary({ sessionId: "s1", title: "fix the lease", projectPath: "/dev/belay" }),
      sessionSummary({ sessionId: "s2", title: "unrelated work", projectPath: "/dev/belay" }),
      sessionSummary({ sessionId: "s3", title: "build sidebar", projectPath: "/dev/other" }),
    ],
  );

  test("filters by project name (case-insensitive)", () => {
    const filtered = filterProjectSidebar(baseGroups, "belay");
    expect(filtered.map((g) => g.key)).toEqual(["/dev/belay"]);
  });

  test("filters by project path", () => {
    const filtered = filterProjectSidebar(baseGroups, "/dev/other");
    expect(filtered.map((g) => g.key)).toEqual(["/dev/other"]);
  });

  test("filters by session title", () => {
    const filtered = filterProjectSidebar(baseGroups, "lease");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.key).toBe("/dev/belay");
    expect(filtered[0]?.sessions.map((s) => s.summary.sessionId)).toEqual(["s1"]);
  });

  test("auto-expands matching projects (sets collapsed false without mutating source)", () => {
    const collapsedGroups = buildProjectSidebar(
      [project({ path: "/dev/belay", collapsed: true })],
      [sessionSummary({ sessionId: "s1", title: "sidebar work", projectPath: "/dev/belay" })],
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
    const filtered = filterProjectSidebar(baseGroups, "belay");
    // /dev/belay matches by name; its sessions are not filtered out because the project matched
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
    baseRepo: "/dev/belay",
    baseRepoName: "belay",
    branch: "feat/x",
    path: "~/dev/.worktrees/belay/feat-x",
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
      [project({ path: "/dev/belay" })],
      [
        sessionSummary({
          sessionId: "wt-s1",
          projectPath: "/dev/belay",
          workspace: "/Users/kevin/dev/.worktrees/belay/feat-x",
          cwd: "/Users/kevin/dev/.worktrees/belay/feat-x",
        }),
      ],
    );
    const group = sole(groups);
    expect(group.key).toBe("/dev/belay");
    expect(group.sessions.map((s) => s.summary.sessionId)).toEqual(["wt-s1"]);
    expect(group.sessions[0]?.worktree).toBeNull();
  });

  test("buildWorktreeSessionMap keys on sessionId and excludes baseline === true", () => {
    const map = buildWorktreeSessionMap([
      wt({ sessionId: "baseline", baseline: true, branch: "main", path: "/dev/belay" }),
      wt({ sessionId: "wt-s1", baseline: false }),
    ]);
    expect(map.has("baseline")).toBe(false);
    expect(map.get("wt-s1")?.sessionId).toBe("wt-s1");
    expect(map.size).toBe(1);
  });

  test("no path inference: worktree-looking paths get no badge when sessionId is absent from the snapshot", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/belay" })],
      [
        sessionSummary({
          sessionId: "orphan-looking",
          projectPath: "/dev/belay",
          workspace: "/Users/kevin/dev/.worktrees/belay/orphan",
          cwd: "/Users/kevin/dev/.worktrees/belay/orphan",
        }),
        sessionSummary({ sessionId: "wt-s1", projectPath: "/dev/belay" }),
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
      [project({ path: "/dev/belay" }), project({ path: "/dev/other" })],
      [
        sessionSummary({ sessionId: "belay-wt", projectPath: "/dev/belay" }),
        sessionSummary({ sessionId: "other-wt", projectPath: "/dev/other" }),
      ],
      // Only the currently viewed host (belay) announced a worktree.
      [wt({ sessionId: "belay-wt" })],
    );
    const belay = groups.find((g) => g.key === "/dev/belay");
    const other = groups.find((g) => g.key === "/dev/other");
    expect(belay?.sessions[0]?.worktree?.sessionId).toBe("belay-wt");
    expect(other?.sessions[0]?.worktree).toBeNull();
  });
});

describe("plan 58.7 durable worktree badge (survives a view switch)", () => {
  test("a session with a durable worktree marker is badged WITHOUT any host snapshot", () => {
    // No worktrees argument at all (e.g. a different session is viewed). The durable marker alone
    // drives the badge - this is the core fix for the vanishing-badge bug.
    const groups = buildProjectSidebar(
      [project({ path: "/dev/belay" })],
      [
        sessionSummary({
          sessionId: "wt-s1",
          projectPath: "/dev/belay",
          worktree: { id: "wt-1", branch: "feat/x", path: "/dev/.worktrees/belay/feat-x" },
        }),
        sessionSummary({ sessionId: "plain", projectPath: "/dev/belay" }),
      ],
    );
    const group = sole(groups);
    const byId = new Map(group.sessions.map((r) => [r.summary.sessionId, r]));
    expect(byId.get("wt-s1")?.worktree).not.toBeNull();
    expect(byId.get("wt-s1")?.worktree?.branch).toBe("feat/x");
    expect(byId.get("plain")?.worktree).toBeNull();
  });

  test("the durable badge enriches with live git state when the viewed host snapshot is present", () => {
    const liveSnapshot = wt({
      sessionId: "wt-s1",
      branch: "feat/x",
      dirty: true,
      ahead: 3,
    });
    const groups = buildProjectSidebar(
      [project({ path: "/dev/belay" })],
      [
        sessionSummary({
          sessionId: "wt-s1",
          projectPath: "/dev/belay",
          worktree: { id: "wt-1", branch: "feat/x", path: "/dev/.worktrees/belay/feat-x" },
        }),
      ],
      [liveSnapshot],
    );
    const group = sole(groups);
    // The live snapshot wins (dirty: true, ahead: 3), not the identity-only default (clean).
    expect(group.sessions[0]?.worktree?.dirty).toBe(true);
    expect(group.sessions[0]?.worktree?.ahead).toBe(3);
  });

  test("the durable badge shows identity-only (clean git state) when the host is not viewed", () => {
    // The worktree's own host is NOT the viewed session, so no live snapshot enriches it. The
    // badge still renders (from the durable marker) with clean/zero defaults for git state.
    const groups = buildProjectSidebar(
      [project({ path: "/dev/belay" })],
      [
        sessionSummary({
          sessionId: "wt-s1",
          projectPath: "/dev/belay",
          worktree: { id: "wt-1", branch: "feat/x", path: "/dev/.worktrees/belay/feat-x" },
        }),
      ],
      // A snapshot for a DIFFERENT session, not wt-s1.
      [wt({ sessionId: "other-wt" })],
    );
    const group = sole(groups);
    expect(group.sessions[0]?.worktree).not.toBeNull();
    expect(group.sessions[0]?.worktree?.branch).toBe("feat/x");
    expect(group.sessions[0]?.worktree?.dirty).toBe(false);
    expect(group.sessions[0]?.worktree?.ahead).toBe(0);
  });
});
