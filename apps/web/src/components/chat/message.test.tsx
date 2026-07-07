import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import { test } from "vitest";
import { ToolCall } from "./message";

test("result-bearing tool rows leave a readable gap before their output", () => {
  const { container } = render(
    <ToolCall name="mcp" args="call: tool-proxy:execute_tool">
      <pre>{'{"object":"list"}'}</pre>
    </ToolCall>,
  );

  const shell = screen.getByText("mcp").closest("[data-state]");
  assert.ok(shell);
  assert.ok(shell.classList.contains("gap-2"));
  assert.equal(container.querySelector("pre")?.textContent, '{"object":"list"}');
});
