import type { Meta, StoryObj } from "@storybook/react-vite";
import type { LoopControl, LoopInventoryRow } from "@trevor/session";
import { useState } from "react";
import { LoopInventory } from "./loop-inventory";

const ROWS: LoopInventoryRow[] = [
  {
    agentBacked: true,
    controls: ["pause", "stop"],
    durability: "session",
    loopId: "loop_1",
    progress: { completed: 3, max: 10 },
    runner: "current_session_prompt",
    status: "running",
    summary: "run the test suite",
  },
  {
    agentBacked: true,
    controls: ["pause", "stop", "run-now", "delete"],
    durability: "durable",
    loopId: "loop_2",
    nextRun: "every 10m",
    progress: { completed: 7 },
    runner: "background_agent",
    status: "running",
    summary: "triage new issues",
  },
  {
    agentBacked: false,
    controls: ["resume", "stop", "run-now", "delete"],
    durability: "durable",
    loopId: "loop_3",
    nextRun: "every 30s",
    progress: { completed: 42 },
    runner: "process",
    status: "paused",
    summary: "curl -sf localhost:8080/health",
  },
  {
    agentBacked: true,
    controls: [],
    durability: "session",
    loopId: "loop_4",
    progress: { completed: 1, max: 1 },
    runner: "current_session_prompt",
    status: "completed",
    summary: "summarize the open PR",
  },
];

const meta: Meta<typeof LoopInventory> = {
  title: "Chat/Loop/Inventory",
  component: LoopInventory,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[32rem] max-w-full">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj;

/** The full inventory across lifecycle states; controls are no-ops here. */
export const Default: Story = {
  args: { rows: ROWS },
};

/** No loops yet - the empty prompt to create one. */
export const Empty: Story = {
  args: { rows: [] },
};

/** Recompute which controls a row offers after its status changes (mirrors the host read model). */
function deriveControls(row: LoopInventoryRow): LoopControl[] {
  const controls: LoopControl[] = [];
  const terminal =
    row.status === "completed" || row.status === "stopped" || row.status === "failed";
  if (row.status === "running") {
    controls.push("pause", "stop");
  } else if (row.status === "paused") {
    controls.push("resume", "stop");
  }
  if (row.nextRun !== undefined && !terminal) {
    controls.push("run-now");
  }
  if (row.durability === "durable") {
    controls.push("delete");
  }
  return controls;
}

function applyControl(row: LoopInventoryRow, control: LoopControl): LoopInventoryRow {
  switch (control) {
    case "pause":
      return { ...row, controls: deriveControls({ ...row, status: "paused" }), status: "paused" };
    case "resume":
      return { ...row, controls: deriveControls({ ...row, status: "running" }), status: "running" };
    case "stop":
      return { ...row, controls: deriveControls({ ...row, status: "stopped" }), status: "stopped" };
    case "run-now":
      return { ...row, progress: { ...row.progress, completed: row.progress.completed + 1 } };
    case "delete":
      return row;
  }
}

/** Working controls: pause/resume/stop change status, run-now bumps progress, delete removes. */
function InteractiveInventory() {
  const [rows, setRows] = useState<LoopInventoryRow[]>(ROWS);

  const onControl = (loopId: string, control: LoopControl) => {
    setRows((prev) =>
      control === "delete"
        ? prev.filter((row) => row.loopId !== loopId)
        : prev.map((row) => (row.loopId === loopId ? applyControl(row, control) : row)),
    );
  };

  return (
    <div className="mx-auto w-[32rem] max-w-full">
      <LoopInventory rows={rows} onControl={onControl} />
    </div>
  );
}

export const Interactive: Story = {
  render: () => <InteractiveInventory />,
};
