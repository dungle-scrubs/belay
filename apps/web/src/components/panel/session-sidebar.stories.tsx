import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SessionSummary } from "@trevor/session";
import { type ResumeContext, ResumeModal } from "../../resume";
import { SessionSidebar } from "./session-sidebar";

/**
 * D-093 M1/M3: the session navigation sidebar, Storybook-first. Covers empty, current-only, many
 * sessions, long titles, long branch, narrow width, tall lists, and the running/queued/settled
 * activity states (M3). Fixtures are production-shaped `SessionSummary`s (the D-090 inventory read
 * model), not story-only row data.
 */

const meta: Meta<typeof SessionSidebar> = {
  title: "Panel/SessionSidebar",
  component: SessionSidebar,
  parameters: { layout: "fullscreen" },
};

export default meta;

type Story = StoryObj<typeof SessionSidebar>;

const NOW = Date.parse("2026-06-27T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function summary(over: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return {
    title: `session ${over.sessionId}`,
    cwd: "~/dev/trevorV2",
    workspace: "~/dev/trevorV2",
    project: "trevorV2",
    branch: "main",
    git: null,
    createdAt: ago(1000 * 60 * 60 * 24),
    updatedAt: ago(1000 * 60 * 30),
    eventCount: 12,
    host: "none",
    activity: "idle",
    archived: false,
    deleted: false,
    ...over,
  };
}

const noop = () => {};

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="h-svh w-[18rem]">{children}</div>;
}

const MANY: SessionSummary[] = [
  summary({
    sessionId: "cur",
    title: "implement the session sidebar",
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
  summary({
    sessionId: "s4",
    title: "recall over compacted spans",
    branch: "feat/recall",
    updatedAt: ago(1000 * 60 * 60 * 24 * 2),
  }),
  summary({
    sessionId: "s5",
    title: "image attachment carousel",
    updatedAt: ago(1000 * 60 * 60 * 24 * 9),
  }),
];

export const ManySessions: Story = {
  render: () => (
    <Frame>
      <SessionSidebar
        sessions={MANY}
        currentSessionId="cur"
        currentProject="trevorV2"
        onSelect={noop}
        nowMs={NOW}
        className="h-full"
      />
    </Frame>
  ),
};

/** Right-click a row to open the Rename / Archive / Delete menu (D-094). Wiring the three action
 *  handlers is what turns on the menu; Rename opens the same inline edit the hover pencil does, and
 *  Delete asks for confirmation first (it is a soft delete - hidden everywhere, log retained). */
export const RowActions: Story = {
  render: () => (
    <Frame>
      <SessionSidebar
        sessions={MANY}
        currentSessionId="cur"
        currentProject="trevorV2"
        onSelect={noop}
        onRename={noop}
        onArchive={noop}
        onDelete={noop}
        nowMs={NOW}
        className="h-full"
      />
    </Frame>
  ),
};

export const CurrentOnly: Story = {
  render: () => (
    <Frame>
      <SessionSidebar
        sessions={[
          summary({
            sessionId: "cur",
            title: "the only session",
            activity: "running",
            host: "live",
          }),
        ]}
        currentSessionId="cur"
        currentProject="trevorV2"
        onSelect={noop}
        nowMs={NOW}
        className="h-full"
      />
    </Frame>
  ),
};

/**
 * The three live activity states side by side (D-093 M3): a running turn (green pulse), work queued
 * behind it (amber pulse, via the live-activity override the send-queue owner supplies), and a
 * settled session showing when it last finished. A never-run session stays a faint idle dot.
 */
export const ActivityStates: Story = {
  render: () => (
    <Frame>
      <SessionSidebar
        sessions={[
          summary({ sessionId: "run", title: "running a turn", activity: "running", host: "live" }),
          summary({ sessionId: "queue", title: "work queued", activity: "running", host: "live" }),
          summary({
            sessionId: "done",
            title: "just settled",
            activity: "settled",
            host: "live",
            updatedAt: ago(1000 * 60 * 12),
          }),
          summary({
            sessionId: "idle",
            title: "never run yet",
            activity: "idle",
            host: "none",
            updatedAt: ago(1000 * 60 * 60 * 26),
          }),
        ]}
        currentSessionId="run"
        currentProject="trevorV2"
        liveActivity={new Map([["queue", "queued"]])}
        onSelect={noop}
        nowMs={NOW}
        className="h-full"
      />
    </Frame>
  ),
};

export const Empty: Story = {
  render: () => (
    <Frame>
      <SessionSidebar
        sessions={[]}
        currentSessionId="none"
        currentProject="trevorV2"
        onSelect={noop}
        nowMs={NOW}
        className="h-full"
      />
    </Frame>
  ),
};

export const LongTitlesAndBranch: Story = {
  render: () => (
    <Frame>
      <SessionSidebar
        sessions={[
          summary({
            sessionId: "cur",
            title:
              "a very long session title that should truncate cleanly instead of wrapping and resizing the row",
            branch: "feat/a-very-long-branch-name-that-also-truncates-without-overflow",
            activity: "running",
            host: "live",
          }),
          summary({ sessionId: "s2", title: "short one" }),
        ]}
        currentSessionId="cur"
        currentProject="trevorV2"
        onSelect={noop}
        nowMs={NOW}
        className="h-full"
      />
    </Frame>
  ),
};

export const NarrowWidth: Story = {
  render: () => (
    <div className="h-svh w-[12rem]">
      <SessionSidebar
        sessions={MANY}
        currentSessionId="cur"
        currentProject="trevorV2"
        onSelect={noop}
        nowMs={NOW}
        className="h-full"
      />
    </div>
  ),
};

export const TallList: Story = {
  render: () => (
    <Frame>
      <SessionSidebar
        sessions={Array.from({ length: 30 }, (_, i) =>
          summary({
            sessionId: `s${i}`,
            title: `session number ${i}`,
            updatedAt: ago(1000 * 60 * (i + 1)),
          }),
        )}
        currentSessionId="s0"
        currentProject="trevorV2"
        onSelect={noop}
        nowMs={NOW}
        className="h-full"
      />
    </Frame>
  ),
};

/**
 * D-093 M5: the sidebar alongside the `/resume` command modal, so the relationship reads at a glance.
 * Both surfaces are fed the SAME inventory (`MANY`) and back the same safe switch action - the sidebar
 * is the always-visible everyday list (left), while `/resume` is the keyboard/search entry point over
 * the identical sessions (the open modal). Neither widens to cross-project search in this slice: both
 * stay scoped to the current project. The sidebar carries its collapse glyph (the dashboard-icon entry
 * point) via `onToggle`.
 */
export const WithResumeModal: Story = {
  render: () => {
    const context: ResumeContext = {
      currentSessionId: "cur",
      currentProject: "trevorV2",
      busy: false,
      nowMs: NOW,
    };
    return (
      <div className="flex h-svh">
        <Frame>
          <SessionSidebar
            sessions={MANY}
            currentSessionId="cur"
            currentProject="trevorV2"
            onSelect={noop}
            onToggle={noop}
            nowMs={NOW}
            className="h-full"
          />
        </Frame>
        <ResumeModal open onOpenChange={noop} sessions={MANY} context={context} onResume={noop} />
      </div>
    );
  },
};
