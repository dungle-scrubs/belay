import type { Meta, StoryObj } from "@storybook/react-vite";
import type { GitStatus, SessionSummary } from "@trevor/session";
import { ResumeModal } from "./ResumeModal";

/**
 * The resume chooser over the shared command modal (D-090), scoped to the current working
 * directory's sessions, driven by inventory fixtures so every host/activity state is reviewable
 * without a live store: live vs stale vs no-host, running/idle, and the disabled current-session
 * + switch-blocked states. Sessions for other projects are filtered out by the cwd scoping.
 */

const NOW = Date.parse("2026-06-26T12:00:00.000Z");

const git: GitStatus = {
  branch: "feat/explicit-resume",
  detached: null,
  dirty: true,
  ahead: 2,
  behind: 0,
  upstream: true,
  worktree: false,
};

const summary = (over: Partial<SessionSummary>): SessionSummary => ({
  sessionId: "s",
  title: "a session",
  cwd: "~/dev/trevorV2",
  workspace: "~/dev/trevorV2",
  project: "trevorV2",
  branch: "main",
  git: null,
  createdAt: "2026-06-25T12:00:00.000Z",
  updatedAt: "2026-06-26T11:00:00.000Z",
  eventCount: 42,
  host: "none",
  activity: "idle",
  archived: false,
  ...over,
});

const sessions: SessionSummary[] = [
  summary({
    sessionId: "cur",
    title: "explicit resume work",
    branch: "feat/explicit-resume",
    git,
    host: "live",
    activity: "running",
    updatedAt: "2026-06-26T11:59:00.000Z",
    eventCount: 412,
  }),
  summary({
    sessionId: "proj-2",
    title: "compaction follow-ups",
    host: "live",
    updatedAt: "2026-06-26T09:00:00.000Z",
    eventCount: 88,
  }),
  summary({
    sessionId: "proj-3",
    title: "queued cleanup",
    host: "stale",
    updatedAt: "2026-06-25T12:00:00.000Z",
    eventCount: 12,
  }),
  summary({
    sessionId: "proj-4",
    title: "no-host replay session",
    host: "none",
    updatedAt: "2026-06-23T12:00:00.000Z",
    eventCount: 230,
  }),
  summary({
    sessionId: "proj-5",
    title: "older audit pass",
    host: "stale",
    updatedAt: "2026-06-19T12:00:00.000Z",
    eventCount: 540,
  }),
  // A different project's session: filtered out by the cwd scoping (proves the scope).
  summary({
    sessionId: "op-1",
    title: "opchain token redaction (other project)",
    cwd: "~/dev/opchain",
    workspace: "~/dev/opchain",
    project: "opchain",
    host: "none",
    updatedAt: "2026-06-23T12:00:00.000Z",
    eventCount: 230,
  }),
];

const meta = {
  title: "Resume/ResumeModal",
  component: ResumeModal,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[560px] w-full bg-background">
        <Story />
      </div>
    ),
  ],
  args: {
    open: true,
    onOpenChange: () => {},
    onResume: () => {},
    sessions,
    context: { currentSessionId: "cur", currentProject: "trevorV2", busy: false, nowMs: NOW },
  },
} satisfies Meta<typeof ResumeModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentDirectorySessions: Story = {};

export const BusyBlocksSwitching: Story = {
  args: {
    context: { currentSessionId: "cur", currentProject: "trevorV2", busy: true, nowMs: NOW },
  },
};

export const Empty: Story = {
  args: { sessions: [] },
};

export const Loading: Story = {
  args: { sessions: [], loading: true },
};

export const InventoryError: Story = {
  args: { sessions: [], error: "session inventory unreachable" },
};
