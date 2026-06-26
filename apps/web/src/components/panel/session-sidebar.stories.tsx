import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SessionSummary } from "@trevor/session";
import { SessionSidebar } from "./session-sidebar";

/**
 * D-093 M1: the session navigation sidebar, Storybook-first. Covers empty, current-only, many
 * sessions, long titles, long branch, narrow width, and tall lists. Fixtures are production-shaped
 * `SessionSummary`s (the D-090 inventory read model), not story-only row data.
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
