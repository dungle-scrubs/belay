import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { test, vi } from "vitest";
import { HostLaunchStatus } from "./host-launch-status";

/**
 * Plan 44.3 M1/M2: the no-host badge's recovery affordances, presentational over an injected state.
 * Proves the four sub-states render distinctly and their single actions fire - the visual restart-vs-fresh
 * distinction lives here (the label), while the launch mechanics live in use-launch.test.tsx.
 */

test("startable shows a Start host button that fires onStart", () => {
  const onStart = vi.fn();
  render(<HostLaunchStatus state={{ phase: "startable", onStart }} />);
  assert.ok(screen.getByText("● no host", { exact: false }), "the no-host badge still reads");
  const button = screen.getByRole("button", { name: "Start host" });
  fireEvent.click(button);
  assert.equal(onStart.mock.calls.length, 1, "activating it fires the start");
});

test("a fresh start reads 'starting host…'", () => {
  render(<HostLaunchStatus state={{ phase: "starting", restarting: false }} />);
  assert.ok(screen.getByText("starting host…"));
  assert.equal(screen.queryByText("restarting host…"), null);
});

test("a stale-host restart reads 'restarting host…'", () => {
  render(<HostLaunchStatus state={{ phase: "starting", restarting: true }} />);
  assert.ok(screen.getByText("restarting host…"), "a host that was here before restarts");
  assert.equal(screen.queryByText("starting host…"), null);
});

test("failed shows the named error and a Retry that fires onRetry", () => {
  const onRetry = vi.fn();
  render(<HostLaunchStatus state={{ phase: "failed", error: "spawn denied", onRetry }} />);
  assert.ok(screen.getByText("spawn denied", { exact: false }), "the failure class is named");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  assert.equal(onRetry.mock.calls.length, 1, "Retry re-launches");
});

test("hint keeps the shell-command fallback and offers no Start button", () => {
  render(
    <HostLaunchStatus
      state={{ phase: "hint", command: "SESSION_ID=x pnpm --filter @trevor/agent-host start" }}
    />,
  );
  assert.ok(screen.getByText("SESSION_ID=x pnpm --filter @trevor/agent-host start"));
  assert.equal(
    screen.queryByRole("button", { name: "Start host" }),
    null,
    "no start without a root",
  );
});
