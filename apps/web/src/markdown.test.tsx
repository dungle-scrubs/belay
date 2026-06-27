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
