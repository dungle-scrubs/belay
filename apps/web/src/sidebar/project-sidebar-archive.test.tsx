import { fireEvent, render } from "@testing-library/react";
import { sessionSummary } from "@trevor/test-kit";
import type { ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectSidebar } from "./project-sidebar";
import { buildProjectSidebar, type ProjectSidebarRecord } from "./project-sidebar-model";

function renderWithTooltip(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

/**
 * Plan 58 M7: the project sidebar's presentational behavior for archive access and the
 * Delete-absence guarantee. Project-filtered "View archive" is available from the project context
 * menu; the global archive browser is pinned at the bottom of the sidebar.
 */

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

function openMenu(container: HTMLElement) {
  const actionsBtn = container.querySelector(
    'button[aria-label="Project actions"]',
  ) as HTMLButtonElement;
  expect(actionsBtn).toBeTruthy();
  fireEvent.click(actionsBtn);
}

describe("ProjectSidebar archive access (M7)", () => {
  test("an empty project renders a 'New session' button that fires onNewSession with the path", () => {
    const groups = buildProjectSidebar([project({ path: "/dev/trevor" })], []);
    const onNewSession = vi.fn<(projectKey: string) => void>();
    const { getByText } = renderWithTooltip(
      <ProjectSidebar
        groups={groups}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onNewSession={onNewSession}
      />,
    );
    const link = getByText("New session");
    fireEvent.click(link);
    expect(onNewSession).toHaveBeenCalledWith("/dev/trevor");
  });

  test("without onNewSession, the empty state shows 'No active sessions' and is not a link", () => {
    const groups = buildProjectSidebar([project({ path: "/dev/trevor" })], []);
    const { getByText, queryByText } = renderWithTooltip(
      <ProjectSidebar
        groups={groups}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
      />,
    );
    expect(getByText("No active sessions")).toBeTruthy();
    expect(queryByText("View archive")).toBeNull();
  });

  test("'View archive' is available from the project context menu and fires onViewArchive", () => {
    const groups = buildProjectSidebar([project({ path: "/dev/trevor" })], []);
    const onViewArchive = vi.fn<(projectKey: string) => void>();
    const { getByText, container } = renderWithTooltip(
      <ProjectSidebar
        groups={groups}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onViewArchive={onViewArchive}
        onRenameProject={() => {}}
        onRemoveProject={() => {}}
      />,
    );
    openMenu(container);
    const link = getByText("View archive");
    fireEvent.click(link);
    expect(onViewArchive).toHaveBeenCalledWith("/dev/trevor");
  });

  test("the global archived sessions entry is pinned at the bottom of the sidebar", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/trevor" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor" })],
    );
    const onViewArchived = vi.fn<() => void>();
    const { getByRole } = renderWithTooltip(
      <ProjectSidebar
        groups={groups}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onViewArchived={onViewArchived}
      />,
    );
    const button = getByRole("button", { name: "Manage archived sessions" });
    fireEvent.click(button);
    expect(onViewArchived).toHaveBeenCalledOnce();
  });

  test("the normal sidebar renders NO Delete button on session rows (Delete is archive-only)", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/trevor" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor" })],
    );
    const { queryByLabelText, queryByText } = renderWithTooltip(
      <ProjectSidebar
        groups={groups}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onViewArchive={() => {}}
      />,
    );
    expect(queryByLabelText("Permanently delete")).toBeNull();
    expect(queryByLabelText("Delete")).toBeNull();
    expect(queryByText("Delete forever")).toBeNull();
  });

  test("the shared project label renders the project name in the row", () => {
    const groups = buildProjectSidebar(
      [project({ path: "/dev/trevor", displayName: "My Trevor" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor" })],
    );
    const { getByText } = renderWithTooltip(
      <ProjectSidebar
        groups={groups}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
      />,
    );
    expect(getByText("My Trevor")).toBeTruthy();
  });
});
