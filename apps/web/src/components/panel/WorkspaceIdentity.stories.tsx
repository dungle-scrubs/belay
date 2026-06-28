import type { Meta, StoryObj } from "@storybook/react-vite";
import type { GitStatus } from "@trevor/session";
import { WorkspaceIdentity } from "./WorkspaceIdentity";

const base: GitStatus = {
  branch: "main",
  detached: null,
  dirty: false,
  ahead: 0,
  behind: 0,
  upstream: true,
  worktree: false,
};

const meta = {
  title: "Panel/WorkspaceIdentity",
  component: WorkspaceIdentity,
  parameters: { layout: "centered" },
  // Constrain to the side-panel width so truncation behaves as it will in the app.
  decorators: [
    (Story) => (
      <div className="w-80 bg-card/40 p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkspaceIdentity>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CleanBranch: Story = {
  args: { cwd: "~/dev/trevorV2", git: base },
};

export const DirtyBranch: Story = {
  args: { cwd: "~/dev/trevorV2", git: { ...base, branch: "feature/sidebar", dirty: true } },
};

export const AheadOnly: Story = {
  args: { cwd: "~/dev/trevorV2", git: { ...base, ahead: 3 } },
};

export const BehindOnly: Story = {
  args: { cwd: "~/dev/trevorV2", git: { ...base, behind: 5 } },
};

export const Diverged: Story = {
  args: {
    cwd: "~/dev/trevorV2",
    git: { ...base, branch: "feat/x", dirty: true, ahead: 2, behind: 4 },
  },
};

export const DetachedHead: Story = {
  args: {
    cwd: "~/dev/trevorV2",
    git: { ...base, branch: null, detached: "a1b2c3d", upstream: false },
  },
};

export const NoUpstream: Story = {
  args: {
    cwd: "~/dev/trevorV2",
    git: { ...base, branch: "wip/local", upstream: false, ahead: 0, behind: 0 },
  },
};

export const NonGitCwd: Story = {
  args: { cwd: "~/Downloads/scratch", git: null },
};

export const LongPath: Story = {
  args: {
    cwd: "~/dev/trevorV2/apps/agent-host/src/very/deeply/nested/directory/structure",
    git: base,
  },
};

export const LongBranch: Story = {
  args: {
    cwd: "~/dev/trevorV2",
    git: {
      ...base,
      branch: "feature/extremely-long-branch-name-that-should-truncate-cleanly",
      dirty: true,
      ahead: 12,
      behind: 7,
    },
  },
};

export const WithWorktrees: Story = {
  args: {
    cwd: "~/dev/saccade",
    git: { ...base, branch: "feat/vision-via-hector-py" },
    worktreeCount: 3,
    onOpenWorktrees: () => {},
  },
};

export const WithOneWorktree: Story = {
  args: {
    cwd: "~/dev/saccade",
    git: { ...base, branch: "feat/vision-via-hector-py" },
    worktreeCount: 1,
    onOpenWorktrees: () => {},
  },
};
