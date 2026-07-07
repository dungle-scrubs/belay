import type { Meta, StoryObj } from "@storybook/react-vite";
import type { JobSnapshot, TaskSnapshot } from "@trevor/session";
import type { ReactNode } from "react";
import type { SupportSubagent } from "./support-panel";
import { SupportPanel } from "./support-panel-view";

/**
 * Plan 09 M6: the thread support panel, Storybook-first. It replaces the task-only panel and is
 * responsive via a `@container` query - two columns (tasks left, background right) only when BOTH
 * sections exist and the container is wide enough, otherwise a single stacked column. States cover the
 * V1-like matrix: tasks only, background only, both (wide two-column + narrow single-column), overflow,
 * and the running/failed/completed row tones. Framed at fixed pixel widths so the container query
 * resolves under the global centering decorator.
 */

const meta: Meta<typeof SupportPanel> = {
  title: "SupportPanel/SupportPanel",
  component: SupportPanel,
  parameters: { layout: "fullscreen" },
  args: { onOpenJobDetail: () => {}, onKillJob: () => {} },
};
export default meta;
type Story = StoryObj<typeof SupportPanel>;

const task = (id: string, status: TaskSnapshot["status"]): TaskSnapshot => ({
  id,
  subject: `Task ${id}`,
  activeForm: `Working on ${id}`,
  status,
  blockedBy: [],
  blocks: [],
});
const sub = (id: string, agent: string, status: string): SupportSubagent => ({
  id,
  agent,
  task: "explore the codebase",
  status,
});
const job = (over: Partial<JobSnapshot> & { id: string; command: string }): JobSnapshot => ({
  source: "bash",
  cwd: "/work",
  startedAt: 1,
  status: "running",
  exitCode: null,
  stdoutTotal: 0,
  stderrTotal: 0,
  ...over,
});

const TASKS: TaskSnapshot[] = [
  task("a", "in_progress"),
  task("b", "pending"),
  task("c", "completed"),
];
const SUBAGENTS: SupportSubagent[] = [
  sub("s1", "explorer", "running"),
  sub("s2", "reviewer", "done"),
];
const JOBS: JobSnapshot[] = [
  job({ id: "p1", command: "pnpm dev", status: "running" }),
  job({ id: "p2", command: "vitest --watch", status: "running" }),
];

/** A fixed-width frame so the `@container` query resolves (wide -> two columns, narrow -> stacked). */
function Frame({ children, width }: { children: ReactNode; width: number }) {
  return (
    <div
      style={{ width, flexShrink: 0 }}
      className="rounded-lg border border-border bg-background px-3 py-2 text-foreground"
    >
      {children}
    </div>
  );
}

export const TasksOnly: Story = {
  render: (args) => (
    <Frame width={560}>
      <SupportPanel {...args} tasks={TASKS} subagents={[]} jobs={[]} />
    </Frame>
  ),
};

export const BackgroundOnly: Story = {
  render: (args) => (
    <Frame width={560}>
      <SupportPanel {...args} tasks={[]} subagents={SUBAGENTS} jobs={JOBS} />
    </Frame>
  ),
};

export const BothWideTwoColumn: Story = {
  render: (args) => (
    <Frame width={760}>
      <SupportPanel {...args} tasks={TASKS} subagents={SUBAGENTS} jobs={JOBS} />
    </Frame>
  ),
};

export const BothNarrowSingleColumn: Story = {
  render: (args) => (
    <Frame width={340}>
      <SupportPanel {...args} tasks={TASKS} subagents={SUBAGENTS} jobs={JOBS} />
    </Frame>
  ),
};

export const ManyRowsOverflow: Story = {
  render: (args) => (
    <Frame width={560}>
      <SupportPanel
        {...args}
        tasks={[]}
        subagents={[sub("s1", "explorer", "running")]}
        jobs={Array.from({ length: 9 }, (_, i) =>
          job({ id: `p${i}`, command: `job-${i} --watch` }),
        )}
      />
    </Frame>
  ),
};

export const RowTones: Story = {
  render: (args) => (
    <Frame width={560}>
      <SupportPanel
        {...args}
        tasks={[]}
        subagents={[sub("s1", "explorer", "running"), sub("s2", "reviewer", "failed")]}
        jobs={[
          job({ id: "p1", command: "running job", status: "running" }),
          job({ id: "p2", command: "completed job", status: "exited", exitCode: 0 }),
          job({ id: "p3", command: "failed job", status: "exited", exitCode: 1 }),
          job({ id: "p4", command: "killed job", status: "killed" }),
        ]}
      />
    </Frame>
  ),
};

/**
 * Plan 52: orphan-reconciled background work. A subagent reaped by orphan recovery renders `interrupted`
 * (terminal tone, its OWN label - distinct from a genuine `failed`), and a `running` job whose owning
 * host is gone (D-003) renders `interrupted` with the kill control inert. Both read as recovered, not
 * crashed - the muted-terminal counterpart to a live "running" row.
 */
export const Interrupted: Story = {
  render: (args) => (
    <Frame width={560}>
      <SupportPanel
        {...args}
        tasks={[]}
        subagents={[
          sub("s1", "explorer", "running"),
          sub("s2", "reviewer", "interrupted"),
          sub("s3", "auditor", "failed"),
        ]}
        jobs={[
          job({ id: "p1", command: "pnpm dev", status: "running" }),
          { ...job({ id: "p2", command: "vitest --watch", status: "running" }), interrupted: true },
        ]}
      />
    </Frame>
  ),
};
