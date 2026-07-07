import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import { LoaderIcon } from "lucide-react";
import { test } from "vitest";
import { compactDisplay as display } from "./compact-fixtures";
import { CompactRow } from "./compact-row";

test("renders the primary label and secondary summary on one line", () => {
  const { getByText } = render(<CompactRow display={display({})} />);
  getByText("bash");
  getByText("ls -la /tmp");
});

test("can suppress a repeated primary label while keeping the summary visible", () => {
  const { container, getByText } = render(
    <CompactRow
      display={display({ primary: "edit", secondary: "src/second.ts" })}
      suppressPrimary
    />,
  );
  getByText("src/second.ts");
  assert.equal(container.querySelector("svg"), null);
  assert.equal(container.querySelector(".sr-only")?.textContent, "edit");
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

test("the expand control is a focusable button with a concise status-describing name (keyboard/SR)", () => {
  const { getByRole } = render(
    <CompactRow
      display={display({
        status: "error",
        primary: "edit",
        secondary: "error: no match",
        hasDetail: true,
      })}
      onToggle={() => {}}
    />,
  );
  const button = getByRole("button");
  button.focus();
  assert.equal(document.activeElement, button, "the compact row action is keyboard-focusable");
  const name = button.getAttribute("aria-label") ?? "";
  assert.match(name, /edit/);
  assert.match(name, /error/);
  // The accessible name summarizes the row; it does not duplicate the whole transcript detail.
  assert.ok(name.length < 120, `accessible name stays concise (was ${name.length})`);
});
