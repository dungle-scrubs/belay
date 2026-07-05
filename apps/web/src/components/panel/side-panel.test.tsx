import assert from "node:assert/strict";
import { render, waitFor } from "@testing-library/react";
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
        workspace="~/dev/trevor"
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
  assert.ok(getByText("~/dev/trevor"));
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

// The usage number picks up the band tone too, so the state is legible even for a viewer who
// only glances at the number rather than the bar.

test("danger band tones the usage number orange", () => {
  const { getByText } = render(<SidePanelBreakdown ctxUsed={182_000} ctxMax={200_000} />);
  const label = getByText(/\(91%\)/);
  assert.ok(label.className.includes("text-smui-orange"));
});

test("critical band bolds the usage number in the destructive tone", () => {
  const { getByText } = render(<SidePanelBreakdown ctxUsed={194_000} ctxMax={200_000} />);
  const label = getByText(/\(97%\)/);
  assert.ok(label.className.includes("font-semibold"));
  assert.ok(label.className.includes("text-destructive"));
});

// Regression: the width transition is armed only for live post-load changes, never on first
// paint or during replay - so a refresh settles without the bar sweeping across (the churn the
// `ready`/`useArmedAfterMount` gate exists to prevent).

test("meter snaps into place on first appearance without a width transition", () => {
  const { container } = render(<SidePanelBreakdown ctxUsed={144_000} ctxMax={200_000} />);
  const fill = container.querySelector(".bg-smui-yellow");
  assert.ok(fill);
  assert.equal(fill?.className.includes("transition-"), false);
});

test("meter stays un-armed through replay (ready=false)", async () => {
  const { container } = render(
    <SidePanelBreakdown ctxUsed={144_000} ctxMax={200_000} ready={false} />,
  );
  // Give any queued animation frame a chance to fire; the replay gate must keep it un-armed.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const fill = container.querySelector(".bg-smui-yellow");
  assert.ok(fill);
  assert.equal(fill?.className.includes("transition-"), false);
});

// The meter carries pressure through color (and, at critical, weight) only - it deliberately does
// NOT restate the transcript's overflow/recovery alerts, so the two never fight or duplicate copy.

test.each([
  ["normal", 84_000],
  ["warning", 144_000],
  ["danger", 182_000],
  ["critical", 194_000],
  ["over-window", 216_000],
])("%s band renders no overflow/pressure prose in the meter", (_label, used) => {
  const { container } = render(<SidePanelBreakdown ctxUsed={used} ctxMax={200_000} />);
  const text = (container.textContent ?? "").toLowerCase();
  for (const word of [
    "overflow",
    "context pressure",
    "recover",
    "warning",
    "danger",
    "critical",
    "limit",
  ]) {
    assert.equal(text.includes(word), false, `meter should not print "${word}"`);
  }
});

test("critical is a stronger color+weight treatment, not a textual alert", () => {
  const { container, getByText } = render(
    <SidePanelBreakdown ctxUsed={194_000} ctxMax={200_000} />,
  );
  // Stronger: destructive fill + a bolded destructive usage number...
  assert.ok(container.querySelector(".bg-destructive"));
  assert.ok(getByText(/\(97%\)/).className.includes("font-semibold"));
  // ...but the only text is still "ctx", the usage number, and the window.
  assert.equal((container.textContent ?? "").toLowerCase().includes("overflow"), false);
});

// Accessibility (D-002): the band and values reach assistive tech through a labelled
// progressbar, so the state never relies on color alone.

test("meter is a labelled progressbar carrying tokens, window, percent, and band", () => {
  const { getByRole } = render(<SidePanelBreakdown ctxUsed={182_000} ctxMax={200_000} />);
  const meter = getByRole("progressbar");
  assert.equal(meter.getAttribute("aria-valuemin"), "0");
  assert.equal(meter.getAttribute("aria-valuemax"), "100");
  assert.equal(meter.getAttribute("aria-valuenow"), "91");
  const label = meter.getAttribute("aria-label") ?? "";
  assert.match(label, /182\.0k/); // tokens
  assert.match(label, /200k/); // window
  assert.match(label, /91%/); // percent
  assert.match(label, /danger/); // band
  // The hover title mirrors the accessible label so mouse users get the same detail.
  assert.equal(meter.getAttribute("title"), label);
});

test("over-window meter caps aria-valuenow at 100 while the label stays honest at 108%", () => {
  const { getByRole } = render(<SidePanelBreakdown ctxUsed={216_000} ctxMax={200_000} />);
  const meter = getByRole("progressbar");
  assert.equal(meter.getAttribute("aria-valuenow"), "100");
  assert.match(meter.getAttribute("aria-label") ?? "", /108%/);
});

test("the armed width transition is disabled under reduced motion", async () => {
  const { container } = render(<SidePanelBreakdown ctxUsed={144_000} ctxMax={200_000} />);
  const fill = () => container.querySelector<HTMLElement>(".bg-smui-yellow");
  // The transition arms a frame after mount; once it does, it must carry the reduced-motion opt-out.
  await waitFor(() => assert.ok(fill()?.className.includes("transition-[width]")));
  assert.ok(fill()?.className.includes("motion-reduce:transition-none"));
});
