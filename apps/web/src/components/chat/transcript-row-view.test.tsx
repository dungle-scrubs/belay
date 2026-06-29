import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import { test } from "vitest";
import { TranscriptRowView } from "@/components/chat/transcript-row-view";
import type { AssistantMessage } from "../../transcript";
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

function renderRow(row: TranscriptRow) {
  return render(
    <TranscriptRowView row={row} showThinking onOpenPath={noop} onDoctorRefresh={noop} />,
  );
}

test("renders typed stop notes for non-automatic adaptive termination causes", () => {
  for (const [cause, title] of [
    ["context_pressure", "context pressure"],
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

test("renders step backstop stops so a paused turn is never silent", () => {
  renderRow(
    assistant({
      stop: {
        cause: "step_backstop",
        action: "paused",
        summary: "Paused at the step backstop.",
      },
    }),
  );

  assert.ok(screen.getByText("paused at step backstop"));
  assert.ok(screen.getByText("Paused at the step backstop."));
  assert.equal(screen.queryByRole("button", { name: /continue/i }), null);
});

test("renders the adaptive step-budget summary verbatim, without special-casing wording", () => {
  // The host now derives the budget per turn (turn-budget.ts), so the summary names an adaptive
  // budget and reason instead of a static "32-step" backstop. The row renders whatever summary the
  // host sends, so no static wording is baked into the view.
  renderRow(
    assistant({
      stop: {
        cause: "step_backstop",
        action: "paused",
        summary:
          "Paused at the adaptive 96-step budget before context pressure (>=1M context -> 96 steps).",
      },
    }),
  );

  assert.ok(screen.getByText("paused at step backstop"));
  assert.ok(
    screen.getByText(/Paused at the adaptive 96-step budget before context pressure/),
    "the adaptive budget and reason render from the host's summary",
  );
});

test("renders legacy stepLimit events without calling them answered", () => {
  renderRow(assistant({ text: "best effort", stepLimit: 32 }));
  assert.ok(screen.getByText("legacy step budget reached after 32 steps"));
  assert.equal(screen.queryByText(/answered after/i), null);
});
