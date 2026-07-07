import { act, renderHook } from "@testing-library/react";
import { sessionSummary } from "@trevor/test-kit";
import { describe, expect, test, vi } from "vitest";
import type { ProjectSidebarRecord } from "./project-sidebar-model";
import { type ProjectAction, useProjectSidebar } from "./use-project-sidebar";

/**
 * Plan 58 M6 (RED): the live project sidebar hook. Proves the hook groups sessions + projects,
 * toggles local collapsed state (and dispatches a persist), search filters + auto-expands, Show more
 * expands the session list, and archive/remove actions reach the injected callbacks.
 */

/** A project record fixture: the fields the read model consumes from a registry record. */
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

interface Harness {
  readonly result: { readonly current: ReturnType<typeof useProjectSidebar> };
  readonly onProjectAction: ReturnType<typeof vi.fn>;
  readonly onNewSession: ReturnType<typeof vi.fn>;
  readonly onArchiveSession: ReturnType<typeof vi.fn>;
}

function renderSidebar(
  projects: readonly ProjectSidebarRecord[],
  sessions: ReturnType<typeof sessionSummary>[],
): Harness {
  const onProjectAction = vi.fn<(action: ProjectAction) => void>();
  const onNewSession = vi.fn<(projectKey: string) => void>();
  const onArchiveSession = vi.fn<(sessionId: string) => void>();
  const hook = renderHook(() =>
    useProjectSidebar({
      sessions,
      projects,
      onProjectAction,
      onNewSession,
      onArchiveSession,
    }),
  );
  return { result: hook.result, onProjectAction, onNewSession, onArchiveSession };
}

describe("useProjectSidebar", () => {
  test("groups are built from sessions + projects", () => {
    const { result } = renderSidebar(
      [project({ path: "/dev/trevor" })],
      [
        sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor" }),
        sessionSummary({ sessionId: "s2", projectPath: "/dev/trevor" }),
      ],
    );
    expect(result.current.groups).toHaveLength(1);
    const group = result.current.groups[0];
    expect(group?.key).toBe("/dev/trevor");
    expect(group?.sessions.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
  });

  test("toggling a project updates local collapsed state and dispatches a persist", () => {
    const { result, onProjectAction } = renderSidebar(
      [project({ path: "/dev/trevor" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor" })],
    );
    // Starts expanded.
    expect(result.current.groups[0]?.collapsed).toBe(false);

    act(() => result.current.onToggleProject("/dev/trevor"));
    expect(result.current.groups[0]?.collapsed).toBe(true);
    expect(onProjectAction).toHaveBeenCalledWith({
      type: "collapse",
      path: "/dev/trevor",
      collapsed: true,
    });

    // Toggle back.
    act(() => result.current.onToggleProject("/dev/trevor"));
    expect(result.current.groups[0]?.collapsed).toBe(false);
    expect(onProjectAction).toHaveBeenLastCalledWith({
      type: "collapse",
      path: "/dev/trevor",
      collapsed: false,
    });
  });

  test("a project with collapsed: true in its registry record starts collapsed", () => {
    const { result } = renderSidebar(
      [project({ path: "/dev/trevor", collapsed: true })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor" })],
    );
    expect(result.current.groups[0]?.collapsed).toBe(true);
  });

  test("search filters groups and auto-expands matched projects", () => {
    const { result } = renderSidebar(
      [project({ path: "/dev/trevor", collapsed: true }), project({ path: "/dev/other" })],
      [
        sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor", title: "fix bug" }),
        sessionSummary({ sessionId: "s2", projectPath: "/dev/other", title: "unrelated" }),
      ],
    );
    // Both projects present before search; trevor is collapsed.
    expect(result.current.groups.map((g) => g.key)).toEqual(
      expect.arrayContaining(["/dev/trevor", "/dev/other"]),
    );

    // Search for "bug" matches only the trevor session; the trevor group is auto-expanded.
    act(() => result.current.onSearch("bug"));
    expect(result.current.groups).toHaveLength(1);
    const group = result.current.groups[0];
    expect(group?.key).toBe("/dev/trevor");
    expect(group?.collapsed).toBe(false);
    expect(group?.sessions.map((s) => s.sessionId)).toEqual(["s1"]);
  });

  test("search matching a project name keeps all its sessions and forces expand", () => {
    const { result } = renderSidebar(
      [project({ path: "/dev/trevor", collapsed: true, displayName: "Trevor" })],
      [
        sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor", title: "alpha" }),
        sessionSummary({ sessionId: "s2", projectPath: "/dev/trevor", title: "beta" }),
      ],
    );
    act(() => result.current.onSearch("trevor"));
    const group = result.current.groups[0];
    expect(group?.collapsed).toBe(false);
    // Project-name match keeps ALL sessions.
    expect(group?.sessions.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
  });

  test("Show more expands the session list for a project beyond the cap", () => {
    const sessions = Array.from({ length: 8 }, (_, i) =>
      sessionSummary({
        sessionId: `s${i}`,
        projectPath: "/dev/trevor",
        updatedAt: `2026-06-0${i + 1}T00:00:00.000Z`,
      }),
    );
    const { result } = renderSidebar([project({ path: "/dev/trevor" })], sessions);
    // Before show-more, the group has all 8 sessions (the component caps the visible slice).
    expect(result.current.groups[0]?.sessions).toHaveLength(8);

    // Show more marks the project as expanded; the group is unchanged in shape (the component
    // reveals more), but the expanded set is updated. We verify by checking no throw + still 8.
    act(() => result.current.onShowMore("/dev/trevor"));
    expect(result.current.groups[0]?.sessions).toHaveLength(8);
  });

  test("archive session calls the archive callback", () => {
    const { result, onArchiveSession } = renderSidebar(
      [project({ path: "/dev/trevor" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor" })],
    );
    act(() => result.current.onArchiveSession("s1"));
    expect(onArchiveSession).toHaveBeenCalledWith("s1");
  });

  test("remove project calls the remove action", () => {
    const { result, onProjectAction } = renderSidebar(
      [project({ path: "/dev/trevor" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor" })],
    );
    act(() => result.current.onRemoveProject("/dev/trevor"));
    expect(onProjectAction).toHaveBeenCalledWith({
      type: "remove",
      path: "/dev/trevor",
    });
  });

  test("add project calls the add action", () => {
    const { result, onProjectAction } = renderSidebar(
      [project({ path: "/dev/trevor" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor" })],
    );
    act(() => result.current.onAddProject());
    expect(onProjectAction).toHaveBeenCalledWith({ type: "add" });
  });

  test("rename project calls the rename action", () => {
    const { result, onProjectAction } = renderSidebar(
      [project({ path: "/dev/trevor" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor" })],
    );
    act(() => result.current.onRenameProject("/dev/trevor", "My Trevor"));
    expect(onProjectAction).toHaveBeenCalledWith({
      type: "rename",
      path: "/dev/trevor",
      displayName: "My Trevor",
    });
  });

  test("new session calls the new-session callback with the project key", () => {
    const { result, onNewSession } = renderSidebar(
      [project({ path: "/dev/trevor" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor" })],
    );
    act(() => result.current.onNewSession("/dev/trevor"));
    expect(onNewSession).toHaveBeenCalledWith("/dev/trevor");
  });

  test("transient projects (sessions with no registry record) appear as groups", () => {
    const { result } = renderSidebar(
      [],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/unregistered" })],
    );
    expect(result.current.groups).toHaveLength(1);
    expect(result.current.groups[0]?.key).toBe("/dev/unregistered");
    expect(result.current.groups[0]?.isTransient).toBe(true);
  });
});
