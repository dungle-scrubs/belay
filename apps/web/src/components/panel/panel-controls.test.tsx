import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import { test } from "vitest";
import { ControlsPanel, type ControlsPanelConfig } from "./panel-controls";

/**
 * The panel's `controls` slot now carries only the show-thinking + compact display toggles; the model
 * + reasoning selection moved to the composer footer (see composer-controls.test.tsx). Pins that both
 * toggles render, reflect state, and fire their onChange.
 */

const noop = () => {};

type ConfigOverride = {
  readonly thinking?: Partial<ControlsPanelConfig["thinking"]>;
  readonly compact?: Partial<ControlsPanelConfig["compact"]>;
};

function config(over: ConfigOverride = {}): ControlsPanelConfig {
  return {
    thinking: {
      show: true,
      onShowChange: noop,
      ...over.thinking,
    },
    compact: {
      show: false,
      onShowChange: noop,
      ...over.compact,
    },
  };
}

function renderControls(over: ConfigOverride = {}) {
  return render(<ControlsPanel config={config(over)} />);
}

test("renders the show-thinking and compact display toggles", () => {
  const { getByText } = renderControls();
  assert.ok(getByText("show thinking"), "the show-thinking control renders");
  assert.ok(getByText("compact"), "the compact control renders");
});

test("the compact toggle reflects state and fires onChange", () => {
  let next: boolean | null = null;
  const { getByLabelText } = renderControls({
    compact: { show: false, onShowChange: (on) => (next = on) },
  });
  const checkbox = getByLabelText("compact");
  assert.equal(checkbox.getAttribute("aria-checked"), "false");
  fireEvent.click(checkbox);
  assert.equal(next, true);
});

test("the show-thinking toggle reflects state and fires onChange", () => {
  let next: boolean | null = null;
  const { getByLabelText } = renderControls({
    thinking: { show: true, onShowChange: (on) => (next = on) },
  });
  const checkbox = getByLabelText("show thinking");
  assert.equal(checkbox.getAttribute("aria-checked"), "true");
  fireEvent.click(checkbox);
  assert.equal(next, false);
});
