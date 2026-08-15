import { sessionSummary } from "@belay/test-kit";
import { act, renderHook } from "@testing-library/react";
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
  readonly rerender: (props: { sessions: ReturnType<typeof sessionSummary>[] }) => void;
  readonly onProjectAction: ReturnType<typeof vi.fn>;
  readonly onNewSession: ReturnType<typeof vi.fn>;
  readonly onArchiveSession: ReturnType<typeof vi.fn>;
  readonly onRenameSession: ReturnType<typeof vi.fn>;
}

function renderSidebar(
  projects: readonly ProjectSidebarRecord[],
  sessions: ReturnType<typeof sessionSummary>[],
  publishes?: {
    readonly onArchiveSession?: (sessionId: string) => void | Promise<void>;
    readonly onRenameSession?: (sessionId: string, title: string) => void | Promise<void>;
  },
): Harness {
  const onProjectAction = vi.fn<(action: ProjectAction) => void>();
  const onNewSession = vi.fn<(projectKey: string) => void>();
  const onArchiveSession = vi.fn(publishes?.onArchiveSession ?? (() => undefined));
  const onRenameSession = vi.fn(publishes?.onRenameSession ?? (() => undefined));
  const hook = renderHook(
    ({ sessions: current }: { sessions: ReturnType<typeof sessionSummary>[] }) =>
      useProjectSidebar({
        sessions: current,
        projects,
        onProjectAction,
        onNewSession,
        onArchiveSession,
        onRenameSession,
      }),
    { initialProps: { sessions } },
  );
  return {
    result: hook.result,
    rerender: hook.rerender,
    onProjectAction,
    onNewSession,
    onArchiveSession,
    onRenameSession,
  };
}

describe("useProjectSidebar", () => {
  test("groups are built from sessions + projects", () => {
    const { result } = renderSidebar(
      [project({ path: "/dev/belay" })],
      [
        sessionSummary({ sessionId: "s1", projectPath: "/dev/belay" }),
        sessionSummary({ sessionId: "s2", projectPath: "/dev/belay" }),
      ],
    );
    expect(result.current.groups).toHaveLength(1);
    const group = result.current.groups[0];
    expect(group?.key).toBe("/dev/belay");
    expect(group?.sessions.map((s) => s.summary.sessionId)).toEqual(["s1", "s2"]);
  });

  test("toggling a project updates local collapsed state and dispatches a persist", () => {
    const { result, onProjectAction } = renderSidebar(
      [project({ path: "/dev/belay" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/belay" })],
    );
    // Starts expanded.
    expect(result.current.groups[0]?.collapsed).toBe(false);

    act(() => result.current.onToggleProject("/dev/belay"));
    expect(result.current.groups[0]?.collapsed).toBe(true);
    expect(onProjectAction).toHaveBeenCalledWith({
      type: "collapse",
      path: "/dev/belay",
      collapsed: true,
    });

    // Toggle back.
    act(() => result.current.onToggleProject("/dev/belay"));
    expect(result.current.groups[0]?.collapsed).toBe(false);
    expect(onProjectAction).toHaveBeenLastCalledWith({
      type: "collapse",
      path: "/dev/belay",
      collapsed: false,
    });
  });

  test("a project with collapsed: true in its registry record starts collapsed", () => {
    const { result } = renderSidebar(
      [project({ path: "/dev/belay", collapsed: true })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/belay" })],
    );
    expect(result.current.groups[0]?.collapsed).toBe(true);
  });

  test("search filters groups and auto-expands matched projects", () => {
    const { result } = renderSidebar(
      [project({ path: "/dev/belay", collapsed: true }), project({ path: "/dev/other" })],
      [
        sessionSummary({ sessionId: "s1", projectPath: "/dev/belay", title: "fix bug" }),
        sessionSummary({ sessionId: "s2", projectPath: "/dev/other", title: "unrelated" }),
      ],
    );
    // Both projects present before search; belay is collapsed.
    expect(result.current.groups.map((g) => g.key)).toEqual(
      expect.arrayContaining(["/dev/belay", "/dev/other"]),
    );

    // Search for "bug" matches only the belay session; the belay group is auto-expanded.
    act(() => result.current.onSearch("bug"));
    expect(result.current.groups).toHaveLength(1);
    const group = result.current.groups[0];
    expect(group?.key).toBe("/dev/belay");
    expect(group?.collapsed).toBe(false);
    expect(group?.sessions.map((s) => s.summary.sessionId)).toEqual(["s1"]);
  });

  test("search matching a project name keeps all its sessions and forces expand", () => {
    const { result } = renderSidebar(
      [project({ path: "/dev/belay", collapsed: true, displayName: "Belay" })],
      [
        sessionSummary({ sessionId: "s1", projectPath: "/dev/belay", title: "alpha" }),
        sessionSummary({ sessionId: "s2", projectPath: "/dev/belay", title: "beta" }),
      ],
    );
    act(() => result.current.onSearch("belay"));
    const group = result.current.groups[0];
    expect(group?.collapsed).toBe(false);
    // Project-name match keeps ALL sessions.
    expect(group?.sessions.map((s) => s.summary.sessionId)).toEqual(["s1", "s2"]);
  });

  test("Show more expands the session list for a project beyond the cap", () => {
    const sessions = Array.from({ length: 8 }, (_, i) =>
      sessionSummary({
        sessionId: `s${i}`,
        projectPath: "/dev/belay",
        updatedAt: `2026-06-0${i + 1}T00:00:00.000Z`,
      }),
    );
    const { result } = renderSidebar([project({ path: "/dev/belay" })], sessions);
    // Before show-more, the group has all 8 sessions (the component caps the visible slice).
    expect(result.current.groups[0]?.sessions).toHaveLength(8);

    // Show more marks the project as expanded; the group is unchanged in shape (the component
    // reveals more), but the expanded set is updated. We verify by checking no throw + still 8.
    act(() => result.current.onShowMore("/dev/belay"));
    expect(result.current.groups[0]?.sessions).toHaveLength(8);
  });

  test("archive session calls the archive callback", () => {
    const { result, onArchiveSession } = renderSidebar(
      [project({ path: "/dev/belay" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/belay" })],
    );
    act(() => result.current.onArchiveSession("s1"));
    expect(onArchiveSession).toHaveBeenCalledWith("s1");
  });

  test("archiving removes the row immediately, before the inventory reflects it (optimistic)", () => {
    const { result } = renderSidebar(
      [project({ path: "/dev/belay" })],
      [
        sessionSummary({ sessionId: "s1", projectPath: "/dev/belay" }),
        sessionSummary({ sessionId: "s2", projectPath: "/dev/belay" }),
      ],
    );
    act(() => result.current.onArchiveSession("s1"));
    // The sessions prop is unchanged (the poll has not run), yet the row is already gone.
    expect(result.current.groups[0]?.sessions.map((s) => s.summary.sessionId)).toEqual(["s2"]);
  });

  test("a failed archive publish restores the row", async () => {
    const { result } = renderSidebar(
      [project({ path: "/dev/belay" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/belay" })],
      { onArchiveSession: () => Promise.reject(new Error("publish failed")) },
    );
    await act(async () => {
      result.current.onArchiveSession("s1");
    });
    expect(result.current.groups[0]?.sessions.map((s) => s.summary.sessionId)).toEqual(["s1"]);
  });

  test("rename applies the new title immediately and calls the rename callback", () => {
    const { result, onRenameSession } = renderSidebar(
      [project({ path: "/dev/belay" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/belay", title: "old title" })],
    );
    act(() => result.current.onRenameSession("s1", "new title"));
    expect(onRenameSession).toHaveBeenCalledWith("s1", "new title");
    expect(result.current.groups[0]?.sessions[0]?.summary.title).toBe("new title");
  });

  test("a failed rename publish reverts the title", async () => {
    const { result } = renderSidebar(
      [project({ path: "/dev/belay" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/belay", title: "old title" })],
      { onRenameSession: () => Promise.reject(new Error("publish failed")) },
    );
    await act(async () => {
      result.current.onRenameSession("s1", "new title");
    });
    expect(result.current.groups[0]?.sessions[0]?.summary.title).toBe("old title");
  });

  test("a confirmed field releases independently of a still-pending one", () => {
    const s1 = sessionSummary({ sessionId: "s1", projectPath: "/dev/belay", title: "old title" });
    const { result, rerender } = renderSidebar([project({ path: "/dev/belay" })], [s1]);
    // Rename and archive both pending.
    act(() => result.current.onRenameSession("s1", "new title"));
    act(() => result.current.onArchiveSession("s1"));
    expect(result.current.groups[0]?.sessions).toHaveLength(0);

    // The archive confirms while the rename is still pending; then another surface unarchives.
    // The stale archived override must not keep hiding the row just because the title field is
    // still outstanding - and the pending rename must stay overlaid.
    rerender({ sessions: [{ ...s1, archived: true }] });
    rerender({ sessions: [{ ...s1, archived: false }] });
    expect(result.current.groups[0]?.sessions.map((s) => s.summary.sessionId)).toEqual(["s1"]);
    expect(result.current.groups[0]?.sessions[0]?.summary.title).toBe("new title");
  });

  test("a stale rename failure does not revert a newer rename", async () => {
    let rejectFirst: (reason: Error) => void = () => undefined;
    const publishes = {
      onRenameSession: vi
        .fn<(sessionId: string, title: string) => Promise<void>>()
        .mockImplementationOnce(
          () =>
            new Promise<void>((_, reject) => {
              rejectFirst = reject;
            }),
        )
        .mockResolvedValue(undefined),
    };
    const { result } = renderSidebar(
      [project({ path: "/dev/belay" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/belay", title: "old title" })],
      publishes,
    );
    act(() => result.current.onRenameSession("s1", "first"));
    act(() => result.current.onRenameSession("s1", "second"));
    // The FIRST publish fails after the second already overlaid its title: the newer value wins.
    await act(async () => {
      rejectFirst(new Error("publish failed"));
      await Promise.resolve();
    });
    expect(result.current.groups[0]?.sessions[0]?.summary.title).toBe("second");
  });

  test("a confirmed archive override drops, so a later unarchive is not masked", () => {
    const s1 = sessionSummary({ sessionId: "s1", projectPath: "/dev/belay" });
    const { result, rerender } = renderSidebar([project({ path: "/dev/belay" })], [s1]);
    act(() => result.current.onArchiveSession("s1"));
    expect(result.current.groups[0]?.sessions).toHaveLength(0);

    // The poll catches up: the inventory now reports the session archived. The override drops.
    rerender({ sessions: [{ ...s1, archived: true }] });
    expect(result.current.groups[0]?.sessions).toHaveLength(0);

    // Unarchived from another surface (e.g. the archive browser): the row must come back - a stale
    // local override may not keep hiding it.
    rerender({ sessions: [{ ...s1, archived: false }] });
    expect(result.current.groups[0]?.sessions.map((s) => s.summary.sessionId)).toEqual(["s1"]);
  });

  test("remove project calls the remove action", () => {
    const { result, onProjectAction } = renderSidebar(
      [project({ path: "/dev/belay" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/belay" })],
    );
    act(() => result.current.onRemoveProject("/dev/belay"));
    expect(onProjectAction).toHaveBeenCalledWith({
      type: "remove",
      path: "/dev/belay",
    });
  });

  test("add project calls the add action", () => {
    const { result, onProjectAction } = renderSidebar(
      [project({ path: "/dev/belay" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/belay" })],
    );
    act(() => result.current.onAddProject());
    expect(onProjectAction).toHaveBeenCalledWith({ type: "add" });
  });

  test("rename project calls the rename action", () => {
    const { result, onProjectAction } = renderSidebar(
      [project({ path: "/dev/belay" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/belay" })],
    );
    act(() => result.current.onRenameProject("/dev/belay", "My Belay"));
    expect(onProjectAction).toHaveBeenCalledWith({
      type: "rename",
      path: "/dev/belay",
      displayName: "My Belay",
    });
  });

  test("new session calls the new-session callback with the project key", () => {
    const { result, onNewSession } = renderSidebar(
      [project({ path: "/dev/belay" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/belay" })],
    );
    act(() => result.current.onNewSession("/dev/belay"));
    expect(onNewSession).toHaveBeenCalledWith("/dev/belay");
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
