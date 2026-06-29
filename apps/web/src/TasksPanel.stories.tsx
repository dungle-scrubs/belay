import type { Meta, StoryObj } from "@storybook/react-vite";
import type { TaskSnapshot, TaskStatus } from "@trevor/session";
import { TasksPanel } from "./TasksPanel";

/**
 * The header task checklist (plan 09). The panel orders by status, caps the visible rows at five,
 * coalesces a burst of fine-grained tasks into grouped count rows, and shows a `...N more` overflow
 * line when work is hidden - while the header count always reflects the full list. These stories
 * cover the everyday short list, the exact cap, a simple overflow, a 10-15 task burst, and the mixed
 * groups-plus-overflow case.
 */

const meta: Meta<typeof TasksPanel> = {
  title: "Chat/TasksPanel",
  component: TasksPanel,
};

export default meta;

type Story = StoryObj<typeof TasksPanel>;

let id = 0;
function task(
  status: TaskStatus,
  activeForm: string,
  over: Partial<TaskSnapshot> = {},
): TaskSnapshot {
  id += 1;
  return {
    id: `task_${id}`,
    subject: activeForm,
    activeForm,
    status,
    blockedBy: [],
    blocks: [],
    ...over,
  };
}

const many = (status: TaskStatus, count: number, label: string): TaskSnapshot[] =>
  Array.from({ length: count }, (_, i) => task(status, `${label} ${i + 1}`));

/** A short, all-individual checklist - the everyday case, no grouping or overflow. */
export const ShortList: Story = {
  render: () => (
    <TasksPanel
      tasks={[
        task("in_progress", "wiring the parser"),
        task("pending", "add tests", { blockedBy: ["task_1"] }),
        task("completed", "scaffold the module"),
      ]}
    />
  ),
};

/** Exactly five tasks - the cap, still all individual rows. */
export const ExactlyFive: Story = {
  render: () => (
    <TasksPanel
      tasks={[
        task("in_progress", "active task"),
        task("pending", "next up"),
        task("pending", "after that"),
        task("completed", "done earlier"),
        task("failed", "abandoned approach"),
      ]}
    />
  ),
};

/** Six tasks - five rows plus a `...1 more` overflow line. */
export const Overflow: Story = {
  render: () => (
    <TasksPanel
      tasks={[
        task("in_progress", "active task"),
        task("pending", "queued one"),
        task("pending", "queued two"),
        task("completed", "done one"),
        task("completed", "done two"),
        task("completed", "done three"),
      ]}
    />
  ),
};

/** A 10-15 task burst - one active row, the rest coalesced into grouped count rows. */
export const BurstGrouped: Story = {
  render: () => (
    <TasksPanel
      tasks={[
        task("in_progress", "wiring the API"),
        ...many("pending", 8, "upcoming"),
        ...many("completed", 5, "done"),
        ...many("failed", 2, "failed"),
      ]}
    />
  ),
};

/** Many active tasks plus lower-priority work - individual active rows, one group, and overflow. */
export const GroupsAndOverflow: Story = {
  render: () => (
    <TasksPanel
      tasks={[
        ...many("in_progress", 4, "running"),
        ...many("pending", 6, "queued"),
        ...many("completed", 3, "finished"),
      ]}
    />
  ),
};
