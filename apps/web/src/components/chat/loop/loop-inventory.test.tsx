import type { LoopInventoryRow } from "@belay/session";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { loopControlCommand } from "./loop-actions";
import { LoopInventory } from "./loop-inventory";

/**
 * The loop inventory (plan 17, M7): presentational over host-provided rows, and its controls SUBMIT
 * structured `/loop <verb> <id>` commands (never mutate loop state locally).
 */

const runningRow: LoopInventoryRow = {
  loopId: "loop_1",
  runner: "process",
  status: "running",
  durability: "durable",
  summary: 'every 5m · do "curl -sf localhost/health"',
  progress: { completed: 2 },
  agentBacked: false,
  controls: ["pause", "stop", "run-now"],
};

test("renders a loop row with its status, runner, progress, and durability", () => {
  render(<LoopInventory rows={[runningRow]} />);
  expect(screen.getByText("running")).toBeTruthy();
  expect(screen.getByText("process")).toBeTruthy();
  expect(screen.getByText("2 run")).toBeTruthy();
  expect(screen.getByText("durable")).toBeTruthy();
  expect(screen.getByText(/curl -sf localhost\/health/)).toBeTruthy();
});

test("shows the empty state that points at /loop when there are no loops", () => {
  render(<LoopInventory rows={[]} />);
  expect(screen.getByText(/No loops yet/)).toBeTruthy();
});

test("a control button issues a structured /loop command, not a local mutation", () => {
  const submitted: string[] = [];
  render(
    <LoopInventory
      rows={[runningRow]}
      onControl={(loopId, control) => submitted.push(loopControlCommand(loopId, control))}
    />,
  );
  fireEvent.click(screen.getByLabelText("Pause loop_1"));
  fireEvent.click(screen.getByLabelText("Stop loop_1"));
  fireEvent.click(screen.getByLabelText("Run now loop_1"));
  expect(submitted).toEqual(["/loop pause loop_1", "/loop stop loop_1", "/loop run-now loop_1"]);
});

test("loopControlCommand maps every control verb to its command", () => {
  expect(loopControlCommand("loop_9", "delete")).toBe("/loop delete loop_9");
  expect(loopControlCommand("loop_9", "resume")).toBe("/loop resume loop_9");
});
