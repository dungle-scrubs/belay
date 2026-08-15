import type { WorktreeSummary } from "@belay/session";
import { sessionSummary } from "@belay/test-kit";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectSidebar } from "./project-sidebar";
import { buildProjectSidebar, type ProjectSidebarRecord } from "./project-sidebar-model";
import { WorktreeBadge, worktreeGitStateLabel, worktreeTooltipText } from "./worktree-badge";

/** TooltipProvider wrap required by Radix tooltips under jsdom. */
function renderWithTooltip(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

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

function wt(over: Partial<WorktreeSummary> & { sessionId: string }): WorktreeSummary {
  return {
    id: over.id ?? over.sessionId,
    baseRepo: "/dev/belay",
    baseRepoName: "belay",
    branch: "feat/x",
    path: "~/.worktrees/belay/feat-x",
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

describe("worktreeGitStateLabel", () => {
  test("returns clean / dirty / N ahead / N behind / conflict / missing", () => {
    expect(worktreeGitStateLabel(wt({ sessionId: "a" }))).toBe("clean");
    expect(worktreeGitStateLabel(wt({ sessionId: "a", dirty: true }))).toBe("dirty");
    expect(worktreeGitStateLabel(wt({ sessionId: "a", ahead: 3 }))).toBe("3 ahead");
    expect(worktreeGitStateLabel(wt({ sessionId: "a", behind: 1 }))).toBe("1 behind");
    expect(worktreeGitStateLabel(wt({ sessionId: "a", conflict: true }))).toBe("conflict");
    expect(worktreeGitStateLabel(wt({ sessionId: "a", missing: true }))).toBe("missing");
  });
});

describe("WorktreeBadge", () => {
  test("renders a FolderGit2 badge labeled worktree", () => {
    renderWithTooltip(<WorktreeBadge worktree={wt({ sessionId: "wt-s1" })} />);
    expect(screen.getByLabelText("worktree")).toBeTruthy();
  });

  test("tooltip hover shows branch, path, and git state", async () => {
    renderWithTooltip(
      <WorktreeBadge
        worktree={wt({
          sessionId: "wt-s1",
          branch: "feat/badge",
          path: "~/.worktrees/belay/feat-badge",
          dirty: true,
          ahead: 2,
        })}
      />,
    );
    const badge = screen.getByLabelText("worktree");
    fireEvent.pointerMove(badge);
    fireEvent.focus(badge);
    await waitFor(() => {
      // Radix leaves a visually-hidden a11y copy of the content, so more than one of each label can
      // appear in the DOM once the tooltip is open.
      expect(screen.getAllByText("feat/badge").length).toBeGreaterThan(0);
      expect(screen.getAllByText("~/.worktrees/belay/feat-badge").length).toBeGreaterThan(0);
      expect(screen.getAllByText("dirty, 2 ahead").length).toBeGreaterThan(0);
    });
  });

  test("tooltip shows the full path (wraps, never truncates) and a copy button", async () => {
    const longPath =
      "~/.worktrees/belay/feat-an-extremely-long-branch-name-that-keeps-going-and-going-and-going";
    renderWithTooltip(
      <WorktreeBadge worktree={wt({ sessionId: "wt-s1", branch: "feat/badge", path: longPath })} />,
    );
    const badge = screen.getByLabelText("worktree");
    fireEvent.pointerMove(badge);
    fireEvent.focus(badge);
    await waitFor(() => {
      // The full path text is present in the tooltip, not clipped by `truncate`.
      expect(screen.getAllByText(longPath).length).toBeGreaterThan(0);
      expect(screen.getAllByLabelText("Copy worktree path").length).toBeGreaterThan(0);
    });
    // The path span must allow wrapping + shrinking (no truncate), so long paths stay distinguishable.
    const pathSpan = screen.getAllByText(longPath)[0];
    if (!pathSpan) throw new Error("path span not rendered");
    expect(pathSpan.className).not.toMatch(/truncate/);
    expect(pathSpan.className).toMatch(/break-all/);
  });

  test("the copy button writes the full path to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderWithTooltip(
      <WorktreeBadge
        worktree={wt({
          sessionId: "wt-s1",
          path: "~/.worktrees/belay/feat-copy-me",
        })}
      />,
    );
    const badge = screen.getByLabelText("worktree");
    fireEvent.pointerMove(badge);
    fireEvent.focus(badge);
    await waitFor(() => {
      expect(screen.getAllByLabelText("Copy worktree path").length).toBeGreaterThan(0);
    });
    // Radix renders a visually-hidden a11y copy of the tooltip, so there are multiple matching
    // buttons; click the first.
    const button = screen.getAllByLabelText("Copy worktree path")[0];
    if (!button) throw new Error("copy button not rendered");
    fireEvent.click(button);
    await waitFor(() => {
      expect(writeText.mock.calls[0]?.[0]).toBe("~/.worktrees/belay/feat-copy-me");
    });
    vi.unstubAllGlobals();
  });

  test("worktreeTooltipText is pure over the summary", () => {
    expect(
      worktreeTooltipText(wt({ sessionId: "x", branch: "b", path: "~/p", behind: 4 })),
    ).toEqual({ branch: "b", path: "~/p", state: "4 behind" });
  });
});

describe("ProjectSidebar SessionRow worktree badge", () => {
  test("a session row with row.worktree renders the worktree badge; without it does not", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/belay" })],
      [
        sessionSummary({
          sessionId: "wt-s1",
          title: "worktree session",
          projectPath: "/dev/belay",
        }),
        sessionSummary({ sessionId: "plain", title: "plain session", projectPath: "/dev/belay" }),
      ],
      [wt({ sessionId: "wt-s1" })],
    );
    // Expand: groups come non-collapsed from fixtures.
    renderWithTooltip(
      <ProjectSidebar
        groups={groups}
        onToggleProject={vi.fn()}
        onSelectSession={vi.fn()}
        onShowMore={vi.fn()}
        searchQuery=""
      />,
    );
    // Exactly one badge: only the joined row.
    const badges = screen.getAllByLabelText("worktree");
    expect(badges).toHaveLength(1);
    expect(screen.getByText("worktree session")).toBeTruthy();
    expect(screen.getByText("plain session")).toBeTruthy();
  });

  test("baseline checkout is never badged even when present in the snapshot", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/belay" })],
      [
        sessionSummary({
          sessionId: "main-checkout",
          title: "main checkout",
          projectPath: "/dev/belay",
        }),
      ],
      [wt({ sessionId: "main-checkout", baseline: true, branch: "main", path: "/dev/belay" })],
    );
    renderWithTooltip(
      <ProjectSidebar
        groups={groups}
        onToggleProject={vi.fn()}
        onSelectSession={vi.fn()}
        onShowMore={vi.fn()}
        searchQuery=""
      />,
    );
    expect(screen.queryByLabelText("worktree")).toBeNull();
  });

  test("long title worktree rows keep a stable left badge layout without collapsing the right slot", () => {
    const long =
      "an extremely long session title that should truncate before the right action slot and after the badge icon without overlapping either";
    const groups = buildProjectSidebar(
      [project({ path: "/dev/belay" })],
      [sessionSummary({ sessionId: "wt-s1", title: long, projectPath: "/dev/belay" })],
      [wt({ sessionId: "wt-s1" })],
    );
    const { container } = renderWithTooltip(
      <ProjectSidebar
        groups={groups}
        onToggleProject={vi.fn()}
        onSelectSession={vi.fn()}
        onShowMore={vi.fn()}
        searchQuery=""
        onArchiveSession={vi.fn()}
      />,
    );
    // Left content holds title + badge; right absolute slot still exists.
    expect(screen.getByLabelText("worktree")).toBeTruthy();
    expect(container.querySelector(".absolute.right-1\\.5")).toBeTruthy();
    // Title still renders (truncated by CSS, not removed).
    expect(screen.getByText(long)).toBeTruthy();
  });
});
