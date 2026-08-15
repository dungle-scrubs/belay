import type { Meta, StoryObj } from "@storybook/react-vite";
import { CommandModal } from "./command-modal";
import type { CommandRow, FooterHint } from "./types";

/**
 * The shared command modal, exercised with both the resume (D-090) and worktree (D-091)
 * fixture sets. Each story renders the modal inline (always open) so its centered layout,
 * row states, selected highlight, and footer hints can be reviewed without a live host.
 */

// --- worktree-style rows (D-091) ---
const worktreeRows: CommandRow[] = [
  {
    id: "baseline",
    label: "main",
    metadata: "~/dev/belay · baseline checkout",
    status: "clean",
    statusTone: "muted",
    current: true,
    group: "belay",
    keywords: ["baseline"],
  },
  {
    id: "wt-sidebar",
    label: "feat/sidebar-git",
    metadata: ".worktrees/belay/feat-sidebar-git-a1b2",
    status: "2 agents",
    statusTone: "active",
    group: "belay",
  },
  {
    id: "wt-resume",
    label: "feat/explicit-resume",
    metadata: ".worktrees/belay/feat-explicit-resume-c3d4",
    status: "needs you",
    statusTone: "attention",
    group: "belay",
  },
  {
    id: "wt-idle",
    label: "fix/flaky-test",
    metadata: ".worktrees/belay/fix-flaky-test-e5f6",
    status: "idle",
    statusTone: "muted",
    group: "belay",
  },
  {
    id: "wt-dirty",
    label: "chore/deps",
    metadata: ".worktrees/belay/chore-deps-7788",
    status: "dirty ↑3 ↓1",
    statusTone: "attention",
    group: "belay",
  },
  {
    id: "wt-conflict",
    label: "feat/merge-back",
    metadata: ".worktrees/belay/feat-merge-back-9900",
    status: "rebase conflict",
    statusTone: "danger",
    group: "belay",
  },
  {
    id: "wt-other",
    label: "main",
    metadata: "~/dev/opchain · baseline checkout",
    status: "clean",
    statusTone: "muted",
    group: "opchain",
  },
  {
    id: "wt-blocked",
    label: "feat/wip",
    metadata: ".worktrees/opchain/feat-wip-1234",
    disabledReason: "run active",
    group: "opchain",
  },
];

const worktreeHints: FooterHint[] = [
  { keys: "↑↓", label: "navigate" },
  { keys: "↵", label: "switch" },
  { keys: "⌘↵", label: "open in split" },
  { keys: "esc", label: "close" },
];

// --- resume-style rows (D-090) ---
const resumeRows: CommandRow[] = [
  {
    id: "s-current-1",
    label: "sidebar git identity",
    metadata: "~/dev/belay · feat/sidebar-git · 412 events",
    status: "running",
    statusTone: "active",
    current: true,
    group: "Current project",
  },
  {
    id: "s-current-2",
    label: "compaction follow-ups",
    metadata: "~/dev/belay · main · 88 events · 2h ago",
    status: "host ready",
    statusTone: "success",
    group: "Current project",
  },
  {
    id: "s-current-3",
    label: "queued cleanup",
    metadata: "~/dev/belay · main · 12 events · 1d ago",
    status: "queued",
    statusTone: "attention",
    group: "Current project",
  },
  {
    id: "s-global-1",
    label: "opchain token redaction",
    metadata: "~/dev/opchain · main · 230 events · 3d ago",
    status: "no host",
    statusTone: "muted",
    group: "Other projects",
  },
  {
    id: "s-global-2",
    label: "emberlm lease audit",
    metadata: "~/dev/emberlm · main · 540 events · 1w ago",
    status: "stale host",
    statusTone: "danger",
    group: "Other projects",
  },
  {
    id: "s-old",
    label: "ancient scratch session",
    metadata: "~/tmp/scratch · (no repo) · 3 events · 40d ago",
    status: "old",
    statusTone: "muted",
    group: "Other projects",
  },
];

const meta = {
  title: "CommandModal/CommandModal",
  component: CommandModal,
  parameters: { layout: "fullscreen" },
  // The modal portals into the body; a tall canvas keeps the centered overlay reviewable.
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
    onSelect: () => {},
    placeholder: "Search…",
    title: "Switch worktree",
    rows: worktreeRows,
  },
} satisfies Meta<typeof CommandModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WorktreeSwitcher: Story = {
  args: { title: "Switch worktree", rows: worktreeRows, footerHints: worktreeHints },
};

export const ResumeChooser: Story = {
  args: { title: "Resume session", rows: resumeRows },
};

export const Empty: Story = {
  args: { title: "Resume session", rows: [], emptyLabel: "No sessions found" },
};

export const Loading: Story = {
  args: { title: "Resume session", rows: [], loading: true },
};

export const InventoryError: Story = {
  args: { title: "Resume session", rows: [], error: "session inventory unreachable" },
};

export const DisabledRow: Story = {
  args: {
    title: "Switch worktree",
    footerHints: worktreeHints,
    rows: [
      worktreeRows[0] as CommandRow,
      { ...(worktreeRows[1] as CommandRow), disabledReason: "switch blocked: run active" },
      worktreeRows[2] as CommandRow,
    ],
  },
};

export const ManyRows: Story = {
  args: {
    title: "Switch worktree",
    footerHints: worktreeHints,
    rows: Array.from({ length: 40 }, (_, i) => ({
      id: `wt-${i}`,
      label: `feat/branch-${i}`,
      metadata: `.worktrees/belay/feat-branch-${i}-${i.toString(16)}`,
      status: i % 3 === 0 ? "dirty" : "clean",
      statusTone: i % 3 === 0 ? ("attention" as const) : ("muted" as const),
      group: "belay",
    })),
  },
};

export const LongLabels: Story = {
  args: {
    title: "Switch worktree",
    footerHints: worktreeHints,
    rows: [
      {
        id: "long",
        label: "feature/extremely-long-branch-name-that-keeps-going-well-past-the-modal-width",
        metadata:
          ".worktrees/belay/feature-extremely-long-branch-name-that-keeps-going-well-past-the-modal-width-abcd",
        status: "dirty ↑12 ↓7",
        statusTone: "attention",
        group: "belay",
      },
    ],
  },
};
