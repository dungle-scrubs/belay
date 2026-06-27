import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { test, vi } from "vitest";
import type { ConcurrentTool } from "@/components/chat/concurrent-tools";
import { TranscriptRowView } from "@/components/chat/transcript-row-view";
import type { AssistantMessage, ToolMessage as ToolMessageData } from "../../transcript";
import type { TranscriptRow } from "../../transcript-rows";

const noop = () => {};

const assistant = (over: Partial<AssistantMessage>): TranscriptRow => ({
  kind: "message",
  id: "message:a1",
  compactAbove: false,
  message: {
    kind: "assistant",
    id: "a1",
    runId: "r1",
    text: "",
    thinking: "",
    done: true,
    warm: true,
    model: "fake",
    ...over,
  },
});

function renderRow(row: TranscriptRow, onStopAction = noop) {
  return render(
    <TranscriptRowView
      row={row}
      showThinking
      toConcurrentTool={(tool: ToolMessageData): ConcurrentTool => ({
        id: tool.id,
        name: tool.name,
        status: "done",
      })}
      onOpenPath={noop}
      onDoctorRefresh={noop}
      onStopAction={onStopAction}
    />,
  );
}

test("renders typed stop notes for adaptive termination causes", () => {
  for (const [cause, title] of [
    ["context_pressure", "context pressure"],
    ["step_backstop", "paused at step backstop"],
    ["loop_stalled", "loop stalled"],
    ["provider_protocol_anomaly", "provider protocol anomaly"],
  ] as const) {
    const view = renderRow(
      assistant({
        stop: {
          cause,
          action: cause === "context_pressure" ? "synthesized" : "paused",
          summary: `${cause} summary`,
        },
      }),
    );
    assert.ok(screen.getByText(title));
    assert.ok(screen.getByText(`${cause} summary`));
    view.unmount();
  }
});

test("typed stop notes expose continuation controls", () => {
  const onStopAction = vi.fn();
  renderRow(
    assistant({
      stop: {
        cause: "step_backstop",
        action: "paused",
        summary: "Paused at the step backstop.",
      },
    }),
    onStopAction,
  );

  fireEvent.click(screen.getByRole("button", { name: /continue/i }));
  fireEvent.click(screen.getByRole("button", { name: /compress/i }));
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));
  fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

  assert.deepEqual(
    onStopAction.mock.calls.map(([action]) => action),
    ["continue", "compress", "retry", "cancel"],
  );
});

test("renders legacy stepLimit events without calling them answered", () => {
  renderRow(assistant({ text: "best effort", stepLimit: 32 }));
  assert.ok(screen.getByText("legacy step budget reached after 32 steps"));
  assert.equal(screen.queryByText(/answered after/i), null);
});
