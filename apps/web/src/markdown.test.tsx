import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, test, vi } from "vitest";
import { Markdown } from "./markdown";

afterEach(() => vi.restoreAllMocks());

test("wraps markdown tables in a horizontal scroll container", () => {
  const { container } = render(
    <Markdown
      text={[
        "| Severity | Finding | Fix |",
        "| --- | --- | --- |",
        "| HIGH | browser_tools_session.py and persistent_browser.py contain long filenames | Split responsibilities into smaller modules |",
      ].join("\n")}
    />,
  );

  const tableScroll = container.querySelector(".trevor-md-table-scroll");
  assert.ok(tableScroll);
  assert.ok(tableScroll.querySelector("table"));
  assert.equal(screen.getByText("Severity").tagName, "TH");
});

test("copies fenced code block contents from the overlay button", () => {
  const writeText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

  render(<Markdown text={"```ts\nconst answer = 42;\nconsole.log(answer);\n```"} />);

  fireEvent.click(screen.getByLabelText("Copy code block"));

  assert.equal(writeText.mock.calls[0]?.[0], "const answer = 42;\nconsole.log(answer);");
});

test("dedents a code block quoted from indented source, keeping relative indentation", () => {
  // Every line shares a 4-space indent; the nested arg is indented one level deeper. After dedent the
  // block starts flush-left but the nested arg keeps its extra indentation.
  const { container } = render(
    <Markdown text={"```python\n    run_config = Config(\n        threshold=5,\n    )\n```"} />,
  );
  const code = container.querySelector("pre code")?.textContent ?? "";
  assert.equal(
    code,
    "run_config = Config(\n    threshold=5,\n)\n",
    "common indent stripped, depth kept",
  );
});

test("dedent is a no-op for an already-flush block and for mixed tab/space indentation", () => {
  const flush = render(<Markdown text={"```\na()\n  b()\n```"} />);
  assert.equal(flush.container.querySelector("pre code")?.textContent, "a()\n  b()\n");

  // A space-indented line and a tab-indented line share no common whitespace prefix -> left untouched.
  const mixed = render(<Markdown text={"```\n    spaces()\n\ttab()\n```"} />);
  assert.equal(mixed.container.querySelector("pre code")?.textContent, "    spaces()\n\ttab()\n");
});

test("the dedented code is what gets copied", () => {
  const writeText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(<Markdown text={"```\n    x = 1\n        y = 2\n```"} />);
  fireEvent.click(screen.getByLabelText("Copy code block"));
  assert.equal(
    writeText.mock.calls[0]?.[0],
    "x = 1\n    y = 2",
    "copy matches the dedented display",
  );
});
