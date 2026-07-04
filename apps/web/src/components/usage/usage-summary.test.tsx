import assert from "node:assert/strict";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { test, vi } from "vitest";
import {
  emptyUsage,
  midTurnSwitchUsage,
  typicalUsage,
  untrustedUsage,
  withFailuresUsage,
} from "./usage-fixtures";
import { UsageSummary } from "./usage-summary";

/**
 * The usage-summary surface (plan 43 M3). Presentational over the `SessionUsage` read model: it shows
 * totals, per-provider and per-model breakdowns, typed failure/retry rows, an empty state, and a copy
 * button. The per-model-segment split (a mid-turn switch -> two model rows) is pinned in the read
 * model's own tests; here we assert the surface renders those rows faithfully.
 */

test("renders totals and per-provider / per-model breakdown rows", () => {
  render(<UsageSummary usage={typicalUsage()} />);

  // Totals: two turns, 440 output tokens (260 + 180) shown once as the total; 9k peak context (max,
  // not a sum) shown in the total AND the top model row.
  assert.ok(screen.getByText("440"));
  assert.ok(screen.getAllByText("9k").length >= 1);
  // Both providers and both models appear (highest output first).
  assert.ok(screen.getByText("deepseek"));
  assert.ok(screen.getByText("zai"));
  assert.ok(screen.getByText("deepseek-chat"));
  assert.ok(screen.getByText("glm-4.6"));
});

test("splits a mid-turn model switch into two model rows", () => {
  render(<UsageSummary usage={midTurnSwitchUsage()} />);

  // One turn, but two model rows - the switch is not attributed to a single model.
  assert.ok(screen.getByText("deepseek-chat"));
  assert.ok(screen.getByText("glm-4.6"));
  // Total output sums both segments (90 + 230); it also appears as the single provider's row total.
  assert.ok(screen.getAllByText("320").length >= 1);
});

test("shows typed failure rows and provider retries", () => {
  render(<UsageSummary usage={withFailuresUsage()} />);

  assert.ok(screen.getByText("rate limited"));
  assert.ok(screen.getByText("provider retries"));
});

test("marks untrusted (unmeasured) figures with a ~", () => {
  render(<UsageSummary usage={untrustedUsage()} />);

  // A provider that reports no usage -> the output total is an untrusted ~0 (total + provider row).
  assert.ok(screen.getAllByText("~0").length >= 1);
  assert.ok(screen.getByText(/includes an unmeasured turn/));
});

test("renders the empty state for a session with no turns", () => {
  render(<UsageSummary usage={emptyUsage()} />);
  assert.ok(screen.getByText("No usage recorded yet."));
});

test("copies a plain-text report to the clipboard", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

  render(<UsageSummary usage={typicalUsage()} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy usage summary" }));

  await waitFor(() => assert.equal(writeText.mock.calls.length, 1));
  assert.match(String(writeText.mock.calls[0]?.[0]), /Usage summary/);
});
