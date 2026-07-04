import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { test } from "vitest";
import { SidePanel, SidePanelBreakdown, SidePanelHeader } from "./side-panel";

test("composes header, breakdown, controls, and footer inside the side drawer", () => {
  const { getByLabelText, getByText } = render(
    <SidePanel
      controls={<button type="button">model control</button>}
      footer={<span>session footer</span>}
    >
      <SidePanelHeader
        title="auth-flow"
        subtitle="session · local"
        workspace="~/dev/trevorV2"
        git={{
          branch: "main",
          detached: null,
          dirty: false,
          ahead: 0,
          behind: 0,
          upstream: true,
          worktree: false,
        }}
      />
      <SidePanelBreakdown ctxUsed={64_000} ctxMax={128_000} totalTokens={4_200} />
    </SidePanel>,
  );

  assert.ok(getByLabelText("session detail"));
  assert.ok(getByText("auth-flow"));
  assert.ok(getByText("session · local"));
  assert.ok(getByText("~/dev/trevorV2"));
  assert.ok(getByText("64.0k (50%)"));
  assert.ok(getByText("4.2k tok"));
  assert.ok(getByText("No turn data yet"));
  assert.ok(getByText("model control"));
  assert.ok(getByText("session footer"));
});

// The band -> fill-color mapping (D-001). One assertion per boundary band so a threshold or
// palette change is a deliberate, visible edit.

test("meter fill uses the quiet primary color in the normal band", () => {
  const { container } = render(<SidePanelBreakdown ctxUsed={84_000} ctxMax={200_000} />);
  assert.ok(container.querySelector(".bg-primary"));
  assert.equal(container.querySelector(".bg-smui-yellow"), null);
  assert.equal(container.querySelector(".bg-smui-orange"), null);
  assert.equal(container.querySelector(".bg-destructive"), null);
});

test("meter fill turns warning yellow at 72%", () => {
  const { container } = render(<SidePanelBreakdown ctxUsed={144_000} ctxMax={200_000} />);
  assert.ok(container.querySelector(".bg-smui-yellow"));
  assert.equal(container.querySelector(".bg-primary"), null);
});

test("meter fill turns danger orange at 91%", () => {
  const { container } = render(<SidePanelBreakdown ctxUsed={182_000} ctxMax={200_000} />);
  assert.ok(container.querySelector(".bg-smui-orange"));
});

test("meter fill turns critical red at 97%", () => {
  const { container } = render(<SidePanelBreakdown ctxUsed={194_000} ctxMax={200_000} />);
  assert.ok(container.querySelector(".bg-destructive"));
});

test("meter label shows compact tokens with percent beside the window", () => {
  const { getByText } = render(<SidePanelBreakdown ctxUsed={64_000} ctxMax={128_000} />);
  assert.ok(getByText("64.0k (50%)"));
  assert.ok(getByText(/of 128k/));
});

test("meter preserves a compact 1M window label", () => {
  const { getByText } = render(<SidePanelBreakdown ctxUsed={420_000} ctxMax={1_000_000} />);
  assert.ok(getByText("420.0k (42%)"));
  assert.ok(getByText(/of 1M/));
});
