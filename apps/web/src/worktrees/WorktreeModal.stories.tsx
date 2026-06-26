import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WorktreeSummary } from "@trevor/session";
import { WorktreeModal } from "./WorktreeModal";
import type { WorktreeActivity } from "./worktree-rows";

/**
 * The managed-worktree switcher over the shared command modal (D-091), driven by host-summary
 * fixtures so every state is reviewable without a live host: baseline checkout, clean/dirty,
 * ahead/behind, rebase conflict, idle/agents-running/needs-you, missing (repair), base-repo
 * grouping, disabled switching while busy, empty, and many rows.
 */

const wt = (over: Partial<WorktreeSummary>): WorktreeSummary => ({
  id: "wt",
  baseRepo: "/dev/trevorV2",
  baseRepoName: "trevorV2",
  branch: "feat/x",
  path: "~/.trevorV2/.worktrees/h/feat-x-wt",
  sessionId: "s-wt",
  dirty: false,
  ahead: 0,
  behind: 0,
  conflict: false,
  detached: false,
  current: false,
  baseline: false,
  missing: false,
  ...over,
});

const worktrees: WorktreeSummary[] = [
  wt({
    id: "baseline",
    branch: "main",
    path: "~/dev/trevorV2",
    baseline: true,
    current: true,
    sessionId: "base",
  }),
  wt({ id: "a", branch: "feat/sidebar-git", sessionId: "s-a" }),
  wt({
    id: "b",
    branch: "feat/explicit-resume",
    dirty: true,
    ahead: 3,
    behind: 1,
    sessionId: "s-b",
  }),
  wt({ id: "c", branch: "feat/merge-back", conflict: true, sessionId: "s-c" }),
  wt({ id: "d", branch: "fix/flaky", sessionId: "s-d" }),
  wt({ id: "e", branch: "chore/gone", missing: true, sessionId: "s-e" }),
  // A second base repo to show grouping.
  wt({
    id: "op-base",
    baseRepo: "/dev/opchain",
    baseRepoName: "opchain",
    branch: "main",
    path: "~/dev/opchain",
    baseline: true,
    sessionId: "op-base",
  }),
];

// Cross-referenced session activity (from the resume inventory): agents-running + needs-you.
const activity = new Map<string, WorktreeActivity>([
  ["s-a", { host: "live", activity: "running" }], // agents running
  ["s-d", { host: "live", activity: "idle" }], // needs you
]);

const meta = {
  title: "Worktrees/WorktreeModal",
  component: WorktreeModal,
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
    onSwitch: () => {},
    worktrees,
    context: { activityBySession: activity, busy: false },
  },
} satisfies Meta<typeof WorktreeModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Switcher: Story = {};

export const BusyBlocksSwitching: Story = {
  args: { context: { activityBySession: activity, busy: true } },
};

export const Empty: Story = {
  args: { worktrees: [] },
};

export const ManyRows: Story = {
  args: {
    worktrees: [
      wt({ id: "baseline", branch: "main", path: "~/dev/trevorV2", baseline: true, current: true }),
      ...Array.from({ length: 30 }, (_, i) =>
        wt({
          id: `m${i}`,
          branch: `feat/branch-${i}`,
          path: `~/.trevorV2/.worktrees/h/feat-branch-${i}`,
          dirty: i % 4 === 0,
          ahead: i % 3,
          sessionId: `s-m${i}`,
        }),
      ),
    ],
  },
};

export const LongBranch: Story = {
  args: {
    worktrees: [
      wt({ id: "baseline", branch: "main", path: "~/dev/trevorV2", baseline: true }),
      wt({
        id: "long",
        branch: "feature/extremely-long-branch-name-that-should-truncate-cleanly-in-the-row",
        path: "~/.trevorV2/.worktrees/h/feature-extremely-long-branch-name-that-should-truncate-cleanly-in-the-row-abcd",
        dirty: true,
        ahead: 12,
        behind: 7,
      }),
    ],
  },
};
