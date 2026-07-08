import { fireEvent, render } from "@testing-library/react";
import { sessionSummary } from "@trevor/test-kit";
import type { ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectSidebar } from "./project-sidebar";
import { buildProjectSidebar, type ProjectSidebarRecord } from "./project-sidebar-model";

/** Wraps the element in a TooltipProvider (needed by ProjectLabel's Radix tooltip). */
function renderWithTooltip(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

/**
 * Plan 58 M8 (action UI): the project sidebar's presentational action surfaces - the header
 * "Add Project" button, the per-project "New Session" hover button, the per-session "Archive"
 * hover button, the right-click context menu (Rename / Remove), inline rename, and the
 * Remove-blocked-when-active guard. All action props are optional; when absent the surface
 * does not render.
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

function groupsWithSession(displayName = "My Trevor") {
  return buildProjectSidebar(
    [project({ path: "/dev/trevor", displayName })],
    [sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor", title: "Fix bugs" })],
  );
}

/** Opens the project context menu by clicking the "Project actions" (MoreVertical) button. */
function openMenu(container: HTMLElement) {
  const actionsBtn = container.querySelector(
    'button[aria-label="Project actions"]',
  ) as HTMLButtonElement;
  expect(actionsBtn).toBeTruthy();
  fireEvent.click(actionsBtn);
}

describe("ProjectSidebar action UI", () => {
  test("the Add Project button renders and calls onAddProject on click", () => {
    const onAddProject = vi.fn<() => void>();
    const { getByLabelText } = renderWithTooltip(
      <ProjectSidebar
        groups={groupsWithSession()}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onAddProject={onAddProject}
      />,
    );
    fireEvent.click(getByLabelText("Add project"));
    expect(onAddProject).toHaveBeenCalledTimes(1);
  });

  test("the Add Project button is absent when onAddProject is not provided", () => {
    const { queryByLabelText } = renderWithTooltip(
      <ProjectSidebar
        groups={groupsWithSession()}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
      />,
    );
    expect(queryByLabelText("Add project")).toBeNull();
  });

  test("the New Session button appears on expanded projects and calls onNewSession", () => {
    const onNewSession = vi.fn<(projectKey: string) => void>();
    const { getByLabelText } = renderWithTooltip(
      <ProjectSidebar
        groups={groupsWithSession()}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onNewSession={onNewSession}
      />,
    );
    fireEvent.click(getByLabelText("New session"));
    expect(onNewSession).toHaveBeenCalledWith("/dev/trevor");
  });

  test("the New Session button is absent on collapsed projects", () => {
    const collapsedGroups = buildProjectSidebar(
      [project({ path: "/dev/trevor", collapsed: true })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor" })],
    );
    const { queryByLabelText } = renderWithTooltip(
      <ProjectSidebar
        groups={collapsedGroups}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onNewSession={() => {}}
      />,
    );
    expect(queryByLabelText("New session")).toBeNull();
  });

  test("the Archive button appears on session rows when onArchiveSession is provided", () => {
    const { getByLabelText } = renderWithTooltip(
      <ProjectSidebar
        groups={groupsWithSession()}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onArchiveSession={() => {}}
      />,
    );
    expect(getByLabelText("Archive session")).toBeTruthy();
  });

  test("the Archive button is absent when onArchiveSession is not provided", () => {
    const { queryByLabelText } = renderWithTooltip(
      <ProjectSidebar
        groups={groupsWithSession()}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
      />,
    );
    expect(queryByLabelText("Archive session")).toBeNull();
  });

  test("clicking the Archive button calls onArchiveSession with the session id", () => {
    const onArchiveSession = vi.fn<(sessionId: string) => void>();
    const { getByLabelText } = renderWithTooltip(
      <ProjectSidebar
        groups={groupsWithSession()}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onArchiveSession={onArchiveSession}
      />,
    );
    fireEvent.click(getByLabelText("Archive session"));
    expect(onArchiveSession).toHaveBeenCalledWith("s1");
  });

  test("Rename session opens an inline editor and writes only on save, not on click", () => {
    const onRenameSession = vi.fn<(sessionId: string, title: string) => void>();
    const { container, getByLabelText } = renderWithTooltip(
      <ProjectSidebar
        groups={groupsWithSession()}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onRenameSession={onRenameSession}
      />,
    );
    // The pencil enters edit mode; it must NOT write on click. The old behavior re-wrote the same
    // title immediately, bumping updatedAt and re-sorting the row to the top without ever showing
    // an editor.
    fireEvent.click(getByLabelText("Rename session"));
    expect(onRenameSession).not.toHaveBeenCalled();
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: "Renamed session" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenameSession).toHaveBeenCalledWith("s1", "Renamed session");
  });

  test("right-clicking a project row opens a context menu with Rename and Remove", () => {
    const { getByText, container } = renderWithTooltip(
      <ProjectSidebar
        groups={groupsWithSession()}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onRenameProject={() => {}}
        onRemoveProject={() => {}}
      />,
    );
    // The project row is the role=button whose aria-expanded reflects the collapse state.
    const projectRow = container.querySelector(
      '[role="button"][aria-expanded="true"]',
    ) as HTMLElement;
    expect(projectRow).toBeTruthy();
    fireEvent.contextMenu(projectRow);
    expect(getByText("Rename")).toBeTruthy();
    expect(getByText("Remove")).toBeTruthy();
  });

  test("the Project actions button also opens the context menu", () => {
    const { getByText, container } = renderWithTooltip(
      <ProjectSidebar
        groups={groupsWithSession()}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onRenameProject={() => {}}
        onRemoveProject={() => {}}
      />,
    );
    openMenu(container);
    expect(getByText("Rename")).toBeTruthy();
    expect(getByText("Remove")).toBeTruthy();
  });

  test("clicking Rename enters inline rename mode with an input", () => {
    const { getByText, container } = renderWithTooltip(
      <ProjectSidebar
        groups={groupsWithSession("Old Name")}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onRenameProject={() => {}}
        onRemoveProject={() => {}}
      />,
    );
    openMenu(container);
    fireEvent.click(getByText("Rename"));
    const input = container.querySelector("input[type='text']") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("Old Name");
  });

  test("typing + Enter calls onRenameProject with the new name", () => {
    const onRenameProject = vi.fn<(key: string, name: string) => void>();
    const { getByText, container } = renderWithTooltip(
      <ProjectSidebar
        groups={groupsWithSession("Old Name")}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onRenameProject={onRenameProject}
        onRemoveProject={() => {}}
      />,
    );
    openMenu(container);
    fireEvent.click(getByText("Rename"));
    const input = container.querySelector("input[type='text']") as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenameProject).toHaveBeenCalledWith("/dev/trevor", "New Name");
  });

  test("Escape in the rename input cancels without calling onRenameProject", () => {
    const onRenameProject = vi.fn<(key: string, name: string) => void>();
    const { getByText, container } = renderWithTooltip(
      <ProjectSidebar
        groups={groupsWithSession("Old Name")}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onRenameProject={onRenameProject}
        onRemoveProject={() => {}}
      />,
    );
    openMenu(container);
    fireEvent.click(getByText("Rename"));
    const input = container.querySelector("input[type='text']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onRenameProject).not.toHaveBeenCalled();
  });

  test("Remove is disabled when the project has active sessions", () => {
    const activeGroups = buildProjectSidebar(
      [project({ path: "/dev/trevor", displayName: "Busy" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor", activity: "running" })],
    );
    const onRemoveProject = vi.fn<(key: string) => void>();
    const { getByText, container } = renderWithTooltip(
      <ProjectSidebar
        groups={activeGroups}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onRemoveProject={onRemoveProject}
        onRenameProject={() => {}}
      />,
    );
    openMenu(container);
    const removeSpan = getByText("Remove");
    const removeBtn = removeSpan.closest("button") as HTMLButtonElement;
    expect(removeBtn).toBeTruthy();
    expect(removeBtn.disabled).toBe(true);
    fireEvent.click(removeBtn);
    expect(onRemoveProject).not.toHaveBeenCalled();
  });

  test("clicking Remove (when not busy) calls onRemoveProject with the project key", () => {
    const onRemoveProject = vi.fn<(key: string) => void>();
    const { getByText, container } = renderWithTooltip(
      <ProjectSidebar
        groups={groupsWithSession("Idle")}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onRemoveProject={onRemoveProject}
        onRenameProject={() => {}}
      />,
    );
    openMenu(container);
    fireEvent.click(getByText("Remove"));
    expect(onRemoveProject).toHaveBeenCalledWith("/dev/trevor");
  });
});
