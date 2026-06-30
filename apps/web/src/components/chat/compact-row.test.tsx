import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import { LoaderIcon, Wrench } from "lucide-react";
import { test } from "vitest";
import type { CompactDisplay } from "./compact-display";
import { CompactRow } from "./compact-row";

function display(over: Partial<CompactDisplay>): CompactDisplay {
  return {
    kind: "tool",
    status: "done",
    icon: Wrench,
    primary: "bash",
    secondary: "ls -la /tmp",
    hasDetail: false,
    ...over,
  };
}

test("renders the primary label and secondary summary on one line", () => {
  const { getByText } = render(<CompactRow display={display({})} />);
  getByText("bash");
  getByText("ls -la /tmp");
});

test("a detail-eligible row with onToggle is a button that toggles and reports expansion", () => {
  let toggles = 0;
  const { getByRole, rerender } = render(
    <CompactRow
      display={display({ hasDetail: true })}
      expanded={false}
      onToggle={() => toggles++}
    />,
  );
  const button = getByRole("button");
  assert.equal(button.getAttribute("aria-expanded"), "false");
  fireEvent.click(button);
  assert.equal(toggles, 1);

  rerender(
    <CompactRow display={display({ hasDetail: true })} expanded={true} onToggle={() => toggles++}>
      <div>the detail</div>
    </CompactRow>,
  );
  assert.equal(getByRole("button").getAttribute("aria-expanded"), "true");
  getByRole("button"); // still one line
});

test("expanded detail content renders only when expanded", () => {
  const { queryByText, rerender } = render(
    <CompactRow display={display({ hasDetail: true })} expanded={false} onToggle={() => {}}>
      <div>hidden detail</div>
    </CompactRow>,
  );
  assert.equal(queryByText("hidden detail"), null);

  rerender(
    <CompactRow display={display({ hasDetail: true })} expanded={true} onToggle={() => {}}>
      <div>hidden detail</div>
    </CompactRow>,
  );
  assert.ok(queryByText("hidden detail"));
});

test("a row without detail is not a button (no expand affordance)", () => {
  const { queryByRole } = render(<CompactRow display={display({ hasDetail: false })} />);
  assert.equal(queryByRole("button"), null);
});

test("a detail-eligible row with no onToggle stays non-interactive", () => {
  const { queryByRole } = render(<CompactRow display={display({ hasDetail: true })} />);
  assert.equal(queryByRole("button"), null);
});

test("a running row spins its leading icon", () => {
  const { container } = render(
    <CompactRow display={display({ status: "running", icon: LoaderIcon })} />,
  );
  assert.ok(container.querySelector(".animate-spin"), "running icon animates");
});

test("a non-running row does not spin", () => {
  const { container } = render(<CompactRow display={display({ status: "done" })} />);
  assert.equal(container.querySelector(".animate-spin"), null);
});

test("the interactive row carries an accessible label describing it", () => {
  const { getByRole } = render(
    <CompactRow
      display={display({ primary: "grep", secondary: "TODO", status: "running", hasDetail: true })}
      onToggle={() => {}}
    />,
  );
  const label = getByRole("button").getAttribute("aria-label") ?? "";
  assert.match(label, /grep/);
  assert.match(label, /running/);
});
