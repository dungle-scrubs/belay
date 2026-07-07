import { fireEvent, render } from "@testing-library/react";
import { sessionSummary } from "@trevor/test-kit";
import { describe, expect, test, vi } from "vitest";
import { ProjectSidebar } from "./project-sidebar";
import { buildProjectSidebar, type ProjectSidebarRecord } from "./project-sidebar-model";

/**
 * Plan 58 M7 (RED): the project sidebar's presentational behavior for archive-filter access and the
 * Delete-absence guarantee. An archive-only project (a registry record with no active sessions)
 * renders a "View archive" link that fires `onViewArchive` with the project's path; and the normal
 * sidebar never renders a Delete affordance on session rows (Delete stays in the archive browser only).
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

describe("ProjectSidebar archive access (M7)", () => {
  test("an archive-only project renders a 'View archive' link that fires onViewArchive with the path", () => {
    // A registry record with NO active sessions => the project's only content is archived sessions.
    const groups = buildProjectSidebar([project({ path: "/dev/trevor" })], []);
    const onViewArchive = vi.fn<(projectKey: string) => void>();
    const { getByText } = render(
      <ProjectSidebar
        groups={groups}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onViewArchive={onViewArchive}
      />,
    );
    const link = getByText("View archive");
    fireEvent.click(link);
    expect(onViewArchive).toHaveBeenCalledWith("/dev/trevor");
  });

  test("without onViewArchive, the empty state shows 'No active sessions' and is not a link", () => {
    const groups = buildProjectSidebar([project({ path: "/dev/trevor" })], []);
    const { getByText, queryByText } = render(
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

  test("the normal sidebar renders NO Delete button on session rows (Delete is archive-only)", () => {
    // A project with an active session: the session row must offer no permanent-delete affordance.
    const groups = buildProjectSidebar(
      [project({ path: "/dev/trevor" })],
      [sessionSummary({ sessionId: "s1", projectPath: "/dev/trevor" })],
    );
    const { queryByLabelText, queryByText } = render(
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
    const { getByText } = render(
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
