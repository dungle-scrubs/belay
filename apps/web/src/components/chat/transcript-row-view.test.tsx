import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import { test } from "vitest";
import { TranscriptRowView } from "@/components/chat/transcript-row-view";
import type { AssistantMessage, Message } from "../../transcript";
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

// 02.11 (M4): every selectable transcript row carries data-message-id so a cross-item selection
// can start or end inside it and be re-resolved by the persisted-highlight model. Message and
// question rows already had it; these guard the tool/result/shell rows the plan also lists.
const messageRow = (message: Message): TranscriptRow =>
  ({ kind: "message", id: `message:${message.id}`, compactAbove: false, message }) as TranscriptRow;

test("a command-result row is a selectable transcript segment", () => {
  const { container } = renderRow(
    messageRow({ kind: "result", id: "res1", command: "/help", text: "command output", ok: true }),
  );
  assert.match(
    container.querySelector('[data-message-id="res1"]')?.textContent ?? "",
    /command output/,
  );
});

test("a tool row is a selectable transcript segment", () => {
  const { container } = renderRow(
    messageRow({ kind: "tool", id: "tool1", name: "read_file", args: "{}", done: true }),
  );
  assert.ok(container.querySelector('[data-message-id="tool1"]'));
});

test("a shell row is a selectable transcript segment", () => {
  const { container } = renderRow(
    messageRow({
      kind: "shell",
      id: "shell1",
      requestId: "rq1",
      command: "ls -la",
      done: true,
      output: "total 0",
      ok: true,
    }),
  );
  assert.ok(container.querySelector('[data-message-id="shell1"]'));
});

test("02.17: a checkpoint breadcrumb renders quietly, not as the alarming step_backstop card", () => {
  const { container } = renderRow(
    messageRow({
      kind: "continued",
      id: "cont1",
      steps: 64,
      pressure: 0.207,
      detail: "continued at step 64 - 20.7% context, room left",
    }),
  );
  assert.match(container.textContent ?? "", /continued at step 64/);
  assert.match(container.textContent ?? "", /20\.7% context, room left/);
  // It is the quiet muted breadcrumb, NOT the alarming pause card: no destructive/alert role and no
  // "paused" / "step backstop" wording.
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.doesNotMatch(container.textContent ?? "", /paused|backstop/i);
});
