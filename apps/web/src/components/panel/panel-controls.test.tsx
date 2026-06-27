import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import type { ModelRef, QuickPickerGroup } from "@trevor/session";
import { test } from "vitest";
import { PanelControls } from "./panel-controls";

/**
 * D-065 M3: the panel's model row is the split control (open-chooser left region + quick-picker
 * chevron), no longer the old single dropdown. Pins that the split control renders, the left region
 * opens the chooser, a quick-pick fires the selection contract, and the reasoning/show-thinking
 * controls still ride alongside it.
 */

const noop = () => {};
const quickGroups: QuickPickerGroup[] = [
  {
    sourceId: "deepseek",
    models: [{ sourceId: "deepseek", modelId: "deepseek-v4", reasoning: "high" }],
  },
];

function renderControls(over: Partial<Parameters<typeof PanelControls>[0]> = {}) {
  return render(
    <PanelControls
      activeLabel="DeepSeek V4 Pro"
      quickGroups={quickGroups}
      sourceLabels={{ deepseek: "DeepSeek V4 Pro" }}
      modelLabels={{ "deepseek-v4": "DeepSeek V4 Pro" }}
      activeModel={{ sourceId: "deepseek", modelId: "deepseek-v4", reasoning: "high" }}
      onOpenChooser={noop}
      onSelectModel={noop}
      reasoningLevels={["off", "high", "xhigh"]}
      reasoning="high"
      onReasoningChange={noop}
      showThinking
      onShowThinkingChange={noop}
      {...over}
    />,
  );
}

test("renders the split model control with the active label and the reasoning/thinking controls", () => {
  const { getByLabelText, getByText } = renderControls();
  assert.ok(getByLabelText("Open model chooser"), "the left region opens the chooser");
  assert.ok(getByLabelText("Recent models"), "the right chevron opens the quick picker");
  assert.ok(getByText("DeepSeek V4 Pro"), "the active model label shows");
  assert.ok(getByText("show thinking"), "the show-thinking control still rides alongside");
});

test("the larger left region opens the full chooser", () => {
  let opened = 0;
  const { getByLabelText } = renderControls({ onOpenChooser: () => (opened += 1) });
  fireEvent.click(getByLabelText("Open model chooser"));
  assert.equal(opened, 1);
});

test("a quick-pick fires onSelectModel with the chosen ModelRef", () => {
  const picked: ModelRef[] = [];
  const { getByLabelText } = renderControls({ onSelectModel: (ref) => picked.push(ref) });
  // Open the quick-picker popover, then pick the one recent model.
  fireEvent.click(getByLabelText("Recent models"));
  fireEvent.click(getByLabelText("Select DeepSeek V4 Pro"));
  assert.deepEqual(picked, [{ sourceId: "deepseek", modelId: "deepseek-v4", reasoning: "high" }]);
});
