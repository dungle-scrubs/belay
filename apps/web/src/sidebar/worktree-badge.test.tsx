import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WorktreeSummary } from "@trevor/session";
import { sessionSummary } from "@trevor/test-kit";
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
    baseRepo: "/dev/trevor",
    baseRepoName: "trevor",
    branch: "feat/x",
    path: "~/.worktrees/trevor/feat-x",
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
          path: "~/.worktrees/trevor/feat-badge",
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
      expect(screen.getAllByText("~/.worktrees/trevor/feat-badge").length).toBeGreaterThan(0);
      expect(screen.getAllByText("dirty, 2 ahead").length).toBeGreaterThan(0);
    });
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
      [project({ path: "/dev/trevor" })],
      [
        sessionSummary({
          sessionId: "wt-s1",
          title: "worktree session",
          projectPath: "/dev/trevor",
        }),
        sessionSummary({ sessionId: "plain", title: "plain session", projectPath: "/dev/trevor" }),
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
      [project({ path: "/dev/trevor" })],
      [
        sessionSummary({
          sessionId: "main-checkout",
          title: "main checkout",
          projectPath: "/dev/trevor",
        }),
      ],
      [wt({ sessionId: "main-checkout", baseline: true, branch: "main", path: "/dev/trevor" })],
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
      [project({ path: "/dev/trevor" })],
      [sessionSummary({ sessionId: "wt-s1", title: long, projectPath: "/dev/trevor" })],
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
