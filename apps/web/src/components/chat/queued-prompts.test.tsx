import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { test } from "vitest";
import { QueuedPrompts } from "@/components/chat/queued-prompts";

test("renders queued prompt text in a compact bottom stack", () => {
  const { container } = render(
    <QueuedPrompts
      queue={[
        { id: "q1", provider: "qwen", text: "queued first" },
        { id: "q2", provider: "qwen", text: "queued second" },
      ]}
      onUnqueue={() => {}}
    />,
  );

  assert.ok(screen.getByText("queued first"));
  assert.ok(screen.getByText("queued second"));
  assert.ok(container.firstElementChild?.className.includes("max-h-40"));
  assert.ok(container.firstElementChild?.className.includes("pl-0"));
  assert.ok(container.firstElementChild?.className.includes("pb-0"));
  assert.ok(screen.getByText("queued first").closest(".text-\\[12px\\]"));
  assert.ok(screen.getByText("queued first").closest(".leading-\\[14px\\]"));
});

test("the unqueue control supersedes the durable prompt by its eventId (plan 47)", () => {
  const unqueued: string[] = [];
  render(
    <QueuedPrompts
      queue={[{ id: "ev-7", provider: "qwen", text: "drop me" }]}
      onUnqueue={(id) => unqueued.push(id)}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Unqueue prompt" }));
  assert.deepEqual(unqueued, ["ev-7"]);
});
