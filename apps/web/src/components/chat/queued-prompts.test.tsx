import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import { test } from "vitest";
import { QueuedPrompts } from "@/components/chat/queued-prompts";

test("renders queued prompt text in a compact bottom stack", () => {
  const { container } = render(
    <QueuedPrompts
      queue={[
        { id: "q1", provider: "qwen", text: "queued first" },
        { id: "q2", provider: "qwen", text: "queued second" },
      ]}
    />,
  );

  assert.ok(screen.getByText("queued first"));
  assert.ok(screen.getByText("queued second"));
  assert.ok(container.firstElementChild?.className.includes("max-h-40"));
});
