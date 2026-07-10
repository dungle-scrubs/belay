import { fireEvent, render } from "@testing-library/react";
import { sessionSummary } from "@trevor/test-kit";
import type { ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectSidebar } from "./project-sidebar";
import {
  buildProjectSidebar,
  missingProjectNote,
  type ProjectSidebarRecord,
} from "./project-sidebar-model";

/**
 * Plan 58.8 M4: the sidebar's missing-project treatment. A registry record the supervisor marked
 * `missing` renders a red project label (tooltip names the dead path), blocks every New-session
 * affordance with the missing-folder message, and leaves the record's sessions fully actionable
 * (select, rename, archive) - durable logs do not depend on the folder.
 */

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

const DEAD = "/dev/deleted";

function missingGroups(sessions = [sessionSummary({ sessionId: "s1", projectPath: DEAD })]) {
  return buildProjectSidebar([project({ path: DEAD, missing: true })], sessions);
}

describe("missing-project model threading", () => {
  test("a record's missing flag threads into its group; unmarked and transient projects read present", () => {
    const groups = buildProjectSidebar(
      [project({ path: DEAD, missing: true }), project({ path: "/dev/live" })],
      [sessionSummary({ sessionId: "t1", projectPath: "/dev/transient" })],
    );
    const byKey = new Map(groups.map((g) => [g.key, g]));
    expect(byKey.get(DEAD)?.missing).toBe(true);
    expect(byKey.get("/dev/live")?.missing).toBe(false);
    expect(byKey.get("/dev/transient")?.missing).toBe(false);
  });

  test("a missing project's sessions stay listed (never filtered by the flag)", () => {
    const groups = missingGroups();
    expect(groups[0]?.sessions.map((s) => s.summary.sessionId)).toEqual(["s1"]);
  });
});

describe("missing-project sidebar treatment", () => {
  test("the project name renders the red missing treatment", () => {
    const { container } = renderWithTooltip(
      <ProjectSidebar
        groups={missingGroups()}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
      />,
    );
    const label = [...container.querySelectorAll("span")].find(
      (el) => el.textContent === "deleted" && el.className.includes("text-smui-red"),
    );
    expect(label, "the missing project's name label is red").toBeTruthy();
  });

  test("the hover New-session button is disabled with the missing-folder message", () => {
    const onNewSession = vi.fn<(projectKey: string) => void>();
    const { getByLabelText } = renderWithTooltip(
      <ProjectSidebar
        groups={missingGroups()}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onNewSession={onNewSession}
      />,
    );
    const btn = getByLabelText("New session") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe(missingProjectNote(DEAD));
    fireEvent.click(btn);
    expect(onNewSession).not.toHaveBeenCalled();
  });

  test("the context menu's New session is blocked with the same message; Remove stays available", () => {
    const onNewSession = vi.fn<(projectKey: string) => void>();
    const onRemoveProject = vi.fn<(key: string) => void>();
    const { container, getByText } = renderWithTooltip(
      <ProjectSidebar
        groups={missingGroups()}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onNewSession={onNewSession}
        onRenameProject={() => {}}
        onRemoveProject={onRemoveProject}
      />,
    );
    fireEvent.click(
      container.querySelector('button[aria-label="Project actions"]') as HTMLButtonElement,
    );
    const newSession = getByText("New session").closest("button") as HTMLButtonElement;
    expect(newSession.disabled).toBe(true);
    expect(newSession.title).toBe(missingProjectNote(DEAD));
    fireEvent.click(newSession);
    expect(onNewSession).not.toHaveBeenCalled();

    // Remove is NOT blocked by missing (only by active sessions, none here).
    fireEvent.click(getByText("Remove").closest("button") as HTMLButtonElement);
    expect(onRemoveProject).toHaveBeenCalledWith(DEAD);
  });

  test("an empty missing project shows the missing message instead of a New-session affordance", () => {
    const { getByText, queryByText } = renderWithTooltip(
      <ProjectSidebar
        groups={buildProjectSidebar([project({ path: DEAD, missing: true })], [])}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onNewSession={() => {}}
      />,
    );
    expect(getByText(missingProjectNote(DEAD))).toBeTruthy();
    expect(queryByText("New session")).toBeNull();
  });

  test("archive and rename on a missing project's sessions stay untouched", () => {
    const onArchiveSession = vi.fn<(sessionId: string) => void>();
    const onRenameSession = vi.fn<(sessionId: string, title: string) => void>();
    const { getByLabelText } = renderWithTooltip(
      <ProjectSidebar
        groups={missingGroups()}
        onToggleProject={() => {}}
        onSelectSession={() => {}}
        onShowMore={() => {}}
        searchQuery=""
        onArchiveSession={onArchiveSession}
        onRenameSession={onRenameSession}
      />,
    );
    fireEvent.click(getByLabelText("Archive session"));
    expect(onArchiveSession).toHaveBeenCalledWith("s1");

    fireEvent.click(getByLabelText("Rename session"));
    const input = document.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "still renamable" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenameSession).toHaveBeenCalledWith("s1", "still renamable");
  });
});
