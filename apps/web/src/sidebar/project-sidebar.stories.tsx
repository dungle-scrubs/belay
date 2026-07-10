import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SessionSummary, WorktreeSummary } from "@trevor/session";
import { sessionSummary } from "@trevor/test-kit";
import { useState } from "react";
import { ProjectSidebar } from "./project-sidebar";
import {
  buildProjectSidebar,
  filterProjectSidebar,
  type ProjectSidebarRecord,
} from "./project-sidebar-model";

/**
 * Plan 58 M5 + 58.2: the project sidebar, Storybook-first. Covers empty project, active project with
 * sessions, duplicate basenames, a running collapsed project, an archive-only project, more than
 * seven sessions (Show more), search-filtered view, and worktree badge rows (joined non-baseline
 * WorktreeSummary only). The component is presentational: it takes the grouped read model +
 * callbacks, with no live data.
 */

const meta: Meta<typeof ProjectSidebar> = {
  title: "Sidebar/ProjectSidebar",
  component: ProjectSidebar,
  parameters: { layout: "fullscreen" },
};

export default meta;

type Story = StoryObj<typeof ProjectSidebar>;

const NOW = Date.parse("2026-07-04T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function project(over: Partial<ProjectSidebarRecord> & { path: string }): ProjectSidebarRecord {
  return {
    displayPath: over.path,
    displayName: over.path.split("/").pop() ?? over.path,
    collapsed: false,
    createdAt: ago(1000 * 60 * 60 * 24 * 30),
    updatedAt: ago(1000 * 60 * 60 * 24),
    ...over,
  };
}

function summary(over: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return sessionSummary({
    title: `session ${over.sessionId}`,
    projectPath: "/dev/trevor",
    workspace: "/dev/trevor",
    cwd: "/dev/trevor",
    project: "trevor",
    updatedAt: ago(1000 * 60 * 30),
    ...over,
  });
}

const noop = () => {};

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="h-svh w-[20rem] border-r border-border bg-background">{children}</div>;
}

/** An interactive wrapper that owns collapse + search state, so stories behave like the live sidebar. */
function InteractiveSidebar({
  projects,
  sessions,
  worktrees,
  initialQuery = "",
  currentSessionId,
  withNewSession = false,
}: {
  projects: readonly ProjectSidebarRecord[];
  sessions: readonly SessionSummary[];
  worktrees?: readonly WorktreeSummary[];
  initialQuery?: string;
  currentSessionId?: string;
  /** Renders the per-project New-session affordances (hover +, context menu, empty state). */
  withNewSession?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(projects.filter((p) => p.collapsed).map((p) => p.path)),
  );
  const [query, setQuery] = useState(initialQuery);
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set());

  const groups = buildProjectSidebar(
    projects.map((p) => ({ ...p, collapsed: collapsed.has(p.path) })),
    sessions,
    worktrees,
  );
  // Show more: when a project is expanded past SESSION_CAP, reveal all its sessions.
  const expanded = groups.map((g) => (showAll.has(g.key) ? { ...g, sessions: g.sessions } : g));
  const filtered = filterProjectSidebar(expanded, query);

  return (
    <Frame>
      <ProjectSidebar
        groups={filtered}
        onToggleProject={(key) =>
          setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(key)) {
              next.delete(key);
            } else {
              next.add(key);
            }
            return next;
          })
        }
        onSelectSession={noop}
        onShowMore={(key) => setShowAll((prev) => new Set(prev).add(key))}
        searchQuery={query}
        onSearchChange={setQuery}
        currentSessionId={currentSessionId}
        onViewArchived={noop}
        onNewSession={withNewSession ? noop : undefined}
        nowMs={NOW}
        className="h-full"
      />
    </Frame>
  );
}

export const EmptyProject: Story = {
  render: () => <InteractiveSidebar projects={[project({ path: "/dev/empty" })]} sessions={[]} />,
};

export const ActiveProject: Story = {
  render: () => (
    <InteractiveSidebar
      projects={[project({ path: "/dev/trevor" })]}
      sessions={[
        summary({
          sessionId: "cur",
          title: "implement the project sidebar",
          activity: "running",
          host: "live",
          updatedAt: ago(1000 * 20),
        }),
        summary({
          sessionId: "s2",
          title: "fix the lease takeover timing",
          branch: "feat/lease",
          updatedAt: ago(1000 * 60 * 8),
        }),
        summary({
          sessionId: "s3",
          title: "doctor dashboard wiring",
          host: "stale",
          updatedAt: ago(1000 * 60 * 60 * 3),
        }),
      ]}
      currentSessionId="cur"
    />
  ),
};

/** Plan 58.8: a project whose folder was deleted renders a red name label with a tooltip naming the
 *  dead path; its sessions stay listed and actionable, but New-session is blocked with the same
 *  message (hover +, context menu, and the empty state of the missing archive-only project). */
export const MissingProject: Story = {
  render: () => (
    <InteractiveSidebar
      withNewSession
      projects={[
        project({ path: "/dev/trevor" }),
        project({ path: "/dev/deleted-worktree", missing: true }),
        project({ path: "/dev/deleted-empty", missing: true }),
      ]}
      sessions={[
        summary({ sessionId: "ok", title: "live project session" }),
        summary({
          sessionId: "d1",
          title: "session of the deleted folder",
          projectPath: "/dev/deleted-worktree",
        }),
        summary({
          sessionId: "d2",
          title: "another readable session",
          projectPath: "/dev/deleted-worktree",
          updatedAt: ago(1000 * 60 * 60 * 5),
        }),
      ]}
    />
  ),
};

export const DuplicateBasenames: Story = {
  render: () => (
    <InteractiveSidebar
      projects={[
        project({ path: "/work/trevor", displayPath: "~/work/trevor" }),
        project({ path: "/home/trevor", displayPath: "~/home/trevor" }),
      ]}
      sessions={[
        summary({ sessionId: "w1", title: "work session one", projectPath: "/work/trevor" }),
        summary({ sessionId: "h1", title: "home session one", projectPath: "/home/trevor" }),
      ]}
    />
  ),
};

export const RunningCollapsed: Story = {
  render: () => (
    <InteractiveSidebar
      projects={[project({ path: "/dev/trevor", collapsed: true })]}
      sessions={[
        summary({
          sessionId: "run",
          title: "running a long turn now",
          activity: "running",
          host: "live",
          updatedAt: ago(1000 * 10),
        }),
        summary({ sessionId: "s2", title: "settled earlier", updatedAt: ago(1000 * 60 * 60) }),
      ]}
    />
  ),
};

export const ArchiveOnly: Story = {
  render: () => (
    <InteractiveSidebar
      projects={[project({ path: "/dev/legacy" })]}
      sessions={[
        summary({
          sessionId: "arch1",
          title: "archived session",
          projectPath: "/dev/legacy",
          archived: true,
        }),
      ]}
    />
  ),
};

export const ShowMore: Story = {
  render: () => (
    <InteractiveSidebar
      projects={[project({ path: "/dev/trevor" })]}
      sessions={Array.from({ length: 9 }, (_, i) =>
        summary({
          sessionId: `s${i}`,
          title: `session number ${i}`,
          updatedAt: ago(1000 * 60 * (i + 1)),
        }),
      )}
    />
  ),
};

export const SearchFiltered: Story = {
  render: () => (
    <InteractiveSidebar
      projects={[project({ path: "/dev/trevor" }), project({ path: "/dev/other" })]}
      sessions={[
        summary({ sessionId: "s1", title: "fix the lease takeover", projectPath: "/dev/trevor" }),
        summary({ sessionId: "s2", title: "unrelated work", projectPath: "/dev/trevor" }),
        summary({ sessionId: "s3", title: "build the sidebar model", projectPath: "/dev/other" }),
      ]}
      initialQuery="lease"
    />
  ),
};

/** All projects collapsed, showing just the project rows with active dots + counts. */
export const AllCollapsed: Story = {
  render: () => (
    <InteractiveSidebar
      projects={[
        project({ path: "/dev/trevor", collapsed: true }),
        project({ path: "/dev/other", collapsed: true }),
      ]}
      sessions={[
        summary({
          sessionId: "run",
          title: "running now",
          activity: "running",
          host: "live",
          projectPath: "/dev/trevor",
        }),
        summary({ sessionId: "s2", title: "idle session", projectPath: "/dev/other" }),
      ]}
    />
  ),
};

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

/** Normal non-worktree rows under a project (no badge). */
export const NormalRows: Story = {
  render: () => (
    <InteractiveSidebar
      projects={[project({ path: "/dev/trevor" })]}
      sessions={[
        summary({ sessionId: "s1", title: "ordinary session one", projectPath: "/dev/trevor" }),
        summary({ sessionId: "s2", title: "ordinary session two", projectPath: "/dev/trevor" }),
      ]}
    />
  ),
};

/** A worktree session badged via the current-host worktree snapshot join. */
export const WorktreeRow: Story = {
  render: () => (
    <InteractiveSidebar
      projects={[project({ path: "/dev/trevor" })]}
      sessions={[
        summary({
          sessionId: "wt-s1",
          title: "implement worktree badge",
          projectPath: "/dev/trevor",
          workspace: "/Users/kevin/dev/.worktrees/trevor/feat-badge",
        }),
        summary({ sessionId: "plain", title: "main checkout session", projectPath: "/dev/trevor" }),
      ]}
      worktrees={[
        wt({
          sessionId: "wt-s1",
          branch: "feat/badge",
          path: "~/.worktrees/trevor/feat-badge",
          dirty: true,
          ahead: 2,
        }),
        wt({
          sessionId: "plain",
          baseline: true,
          branch: "main",
          path: "/dev/trevor",
        }),
      ]}
    />
  ),
};

/** Long-title worktree row: badge stays beside the title; right slot remains absolute. */
export const LongTitleWorktree: Story = {
  render: () => (
    <InteractiveSidebar
      projects={[project({ path: "/dev/trevor" })]}
      sessions={[
        summary({
          sessionId: "wt-long",
          title:
            "an extremely long session title that must truncate cleanly before the right action slot while still leaving room for the worktree badge",
          projectPath: "/dev/trevor",
        }),
      ]}
      worktrees={[
        wt({
          sessionId: "wt-long",
          branch: "feat/long-title",
          path: "~/.worktrees/trevor/feat-long-title-that-also-abbreviates",
          behind: 1,
        }),
      ]}
    />
  ),
};

/** Baseline checkout is present in the snapshot but never badged. */
export const BaselineNoBadge: Story = {
  render: () => (
    <InteractiveSidebar
      projects={[project({ path: "/dev/trevor" })]}
      sessions={[
        summary({
          sessionId: "main-checkout",
          title: "main checkout (baseline)",
          projectPath: "/dev/trevor",
        }),
      ]}
      worktrees={[
        wt({
          sessionId: "main-checkout",
          baseline: true,
          branch: "main",
          path: "/dev/trevor",
        }),
      ]}
    />
  ),
};
