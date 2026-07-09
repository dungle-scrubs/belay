import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { test } from "vitest";
import { ToolCall } from "./message";

test("result-bearing tool rows keep output close to the tool name", () => {
  const { container } = render(
    <ToolCall name="mcp" args="call: tool-proxy:execute_tool">
      <pre>{'{"object":"list"}'}</pre>
    </ToolCall>,
  );

  const shell = container.firstElementChild;
  assert.ok(shell);
  assert.ok(shell.classList.contains("gap-1"));
  assert.equal(container.querySelector("pre")?.textContent, '{"object":"list"}');
});
