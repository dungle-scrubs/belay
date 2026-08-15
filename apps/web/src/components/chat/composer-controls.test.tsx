import assert from "node:assert/strict";
import type { ModelRef, QuickPickerGroup } from "@belay/session";
import { fireEvent, render } from "@testing-library/react";
import { test } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ComposerControls, type ComposerControlsConfig } from "./composer-controls";

/**
 * The composer footer controls: the D-065 split model control (open-chooser left region + quick-picker
 * chevron) plus the reasoning control, which collapses to a single button showing the active level with
 * the full list behind a popover. Pins the split control wiring and the reasoning popover selection.
 */

const noop = () => {};
const quickGroups: QuickPickerGroup[] = [
  {
    sourceId: "deepseek",
    models: [{ sourceId: "deepseek", modelId: "deepseek-v4", reasoning: "high" }],
  },
];

type ConfigOverride = {
  readonly model?: Partial<ComposerControlsConfig["model"]>;
  readonly reasoning?: Partial<ComposerControlsConfig["reasoning"]>;
  readonly context?: Partial<ComposerControlsConfig["context"]>;
};

function config(over: ConfigOverride = {}): ComposerControlsConfig {
  return {
    model: {
      activeLabel: "GPT-5.6 Sol",
      quickGroups,
      sourceLabels: { deepseek: "DeepSeek V4 Pro" },
      modelLabels: { "deepseek-v4": "DeepSeek V4 Pro" },
      activeModel: { sourceId: "deepseek", modelId: "deepseek-v4", reasoning: "high" },
      onOpenChooser: noop,
      onSelectModel: noop,
      ...over.model,
    },
    reasoning: {
      levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      selected: "medium",
      onChange: noop,
      ...over.reasoning,
    },
    context: {
      ctxUsed: 100_000,
      ctxMax: 272_000,
      ...over.context,
    },
  };
}

function renderControls(over: ConfigOverride = {}) {
  // Radix tooltips (the context gauge's hover card) require a TooltipProvider ancestor under jsdom.
  return render(
    <TooltipProvider>
      <ComposerControls config={config(over)} />
    </TooltipProvider>,
  );
}

test("renders the split model control and the active reasoning level", () => {
  const { getByLabelText, getByText } = renderControls();
  assert.ok(getByLabelText("Open model chooser"), "the left region opens the chooser");
  assert.ok(getByLabelText("Recent models"), "the right chevron opens the quick picker");
  assert.ok(getByText("GPT-5.6 Sol"), "the active model label shows");
  assert.ok(getByLabelText("Reasoning: medium"), "the reasoning trigger shows the active level");
});

test("the larger left region opens the full chooser", () => {
  let opened = 0;
  const { getByLabelText } = renderControls({ model: { onOpenChooser: () => (opened += 1) } });
  fireEvent.click(getByLabelText("Open model chooser"));
  assert.equal(opened, 1);
});

test("a quick-pick fires onSelectModel with the chosen ModelRef", () => {
  const picked: ModelRef[] = [];
  const { getByLabelText } = renderControls({
    model: { onSelectModel: (ref) => picked.push(ref) },
  });
  fireEvent.click(getByLabelText("Recent models"));
  fireEvent.click(getByLabelText("Select DeepSeek V4 Pro"));
  assert.deepEqual(picked, [{ sourceId: "deepseek", modelId: "deepseek-v4", reasoning: "high" }]);
});

test("the reasoning popover lists every level and a pick fires onChange", () => {
  const chosen: string[] = [];
  const { getByLabelText, getByText } = renderControls({
    reasoning: { selected: "medium", onChange: (level) => chosen.push(level) },
  });
  // Open the popover from the trigger, then pick a different level.
  fireEvent.click(getByLabelText("Reasoning: medium"));
  fireEvent.click(getByText("xhigh"));
  assert.deepEqual(chosen, ["xhigh"]);
});

test("reasoning is omitted when the model exposes no levels", () => {
  const { queryByLabelText } = renderControls({ reasoning: { levels: [] } });
  assert.equal(queryByLabelText("Reasoning: medium"), null, "no reasoning trigger renders");
});

test("the context gauge renders with a usage label derived from the shared policy", () => {
  const { getByRole } = renderControls({ context: { ctxUsed: 100_000, ctxMax: 272_000 } });
  const gauge = getByRole("img");
  // 100k / 272k = 37% -> the shared contextPressureState label, carried on the gauge for a11y.
  assert.match(gauge.getAttribute("aria-label") ?? "", /37%/);
});

test("the context gauge is omitted when usage cannot be derived", () => {
  const { queryByRole } = renderControls({ context: { ctxUsed: undefined, ctxMax: undefined } });
  assert.equal(queryByRole("img"), null, "no gauge renders without usage data");
});
