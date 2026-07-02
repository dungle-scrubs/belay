import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { test, vi } from "vitest";
import { TranscriptRowView } from "@/components/chat/transcript-row-view";
import type { AssistantMessage, Message } from "../../transcript";
import type { TranscriptRow } from "../../transcript-rows";

const noop = () => {};

const userRow = (message: Extract<Message, { kind: "user" }>): TranscriptRow => ({
  kind: "message",
  id: `message:${message.id}`,
  compactAbove: false,
  message,
});

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

const resultRow = (message: Extract<Message, { kind: "result" }>): TranscriptRow => ({
  kind: "message",
  id: `message:${message.id}`,
  compactAbove: false,
  message,
});

const toolRow = (over: Partial<Extract<Message, { kind: "tool" }>> = {}): TranscriptRow => ({
  kind: "message",
  id: "message:c1",
  compactAbove: false,
  message: { kind: "tool", id: "c1", name: "bash", args: '{"command":"ls"}', done: true, ...over },
});

test("a tool row exposes the inspect affordance, which opens its detail (plan 08 M5)", () => {
  const onOpenDetail = vi.fn();
  render(
    <TranscriptRowView
      row={toolRow()}
      showThinking
      onOpenPath={noop}
      onDoctorRefresh={noop}
      onOpenDetail={onOpenDetail}
    />,
  );
  fireEvent.click(screen.getByLabelText("Inspect tool detail"));
  assert.equal(onOpenDetail.mock.calls.length, 1);
  assert.equal(onOpenDetail.mock.calls[0]?.[0]?.id, "c1");
});

const switchRow = (over: Partial<Extract<Message, { kind: "modelSwitch" }>>): TranscriptRow => ({
  kind: "message",
  id: "message:sw1",
  compactAbove: false,
  message: {
    kind: "modelSwitch",
    id: "sw1",
    from: { model: "deepseek-v4", reasoning: "high" },
    to: { model: "deepseek-v4", reasoning: "medium" },
    initiator: "manual",
    outcome: "applied",
    ...over,
  },
});

test("09.1 M3: a reasoning-only switch renders the from -> to delta", () => {
  renderRow(switchRow({}));
  assert.match(
    screen.getByText(/deepseek-v4/).textContent ?? "",
    /deepseek-v4 \(high\) -> deepseek-v4 \(medium\)/,
  );
});

test("09.1 M3: a blocked switch renders its reason instead of a delta", () => {
  renderRow(
    switchRow({
      outcome: "blocked",
      to: { model: "haiku-4-5", reasoning: "high" },
      reason: "conversation does not fit the smaller context window",
    }),
  );
  assert.ok(screen.getByText(/blocked/));
  assert.ok(screen.getByText(/smaller context window/));
});

test("a compact tool row also exposes the inspect affordance without expanding first (plan 08 M5)", () => {
  const onOpenDetail = vi.fn();
  render(
    <TranscriptRowView
      row={toolRow()}
      compact
      showThinking
      onOpenPath={noop}
      onDoctorRefresh={noop}
      onOpenDetail={onOpenDetail}
    />,
  );
  fireEvent.click(screen.getByLabelText("Inspect tool detail"));
  assert.equal(onOpenDetail.mock.calls.length, 1);
});

test("a command result carrying a menu renders the nested menu and dispatches a row as a command (plan 03)", () => {
  const onMenuAction = vi.fn();
  render(
    <TranscriptRowView
      row={resultRow({
        kind: "result",
        id: "m1",
        command: "/style",
        text: "Output style",
        ok: true,
        menu: {
          family: "style",
          title: "Output style",
          rows: [{ id: "concise", label: "Concise" }],
        },
      })}
      showThinking
      onOpenPath={noop}
      onDoctorRefresh={noop}
      onMenuAction={onMenuAction}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Concise/ }));
  assert.deepEqual(onMenuAction.mock.calls[0], ["/style", "concise"]);
});

test("a plain command result (no menu) renders its text, not a menu", () => {
  renderRow(
    resultRow({ kind: "result", id: "m2", command: "/help", text: "the help output", ok: true }),
  );
  assert.ok(screen.getByText("the help output"));
});

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

test("a protocol-anomaly diagnostic renders the leaked markup escaped, not as markdown", () => {
  const leak = '<tool_call>{"name":"read","arguments":{"path":"AGENTS.md"}}</tool_call>';
  const { container } = renderRow(
    assistant({
      text: leak,
      stop: {
        cause: "provider_protocol_anomaly",
        action: "paused",
        summary: "Provider protocol anomaly during model-step",
      },
      diagnostic: {
        provider: "deepseek",
        phase: "tool-protocol",
        reason: "protocol_anomaly",
        retryable: true,
        safeToRetry: false,
        attempt: 1,
        detail: "DeepSeek rendered tool-call JSON or tags as assistant text",
        partials: { textChars: leak.length, thinkingChars: 0, toolCalls: 0, toolResults: 0 },
      },
    }),
  );

  // The anomaly alert and its sanitized explanation render.
  assert.ok(screen.getByText("provider protocol anomaly"));
  assert.ok(screen.getByText("DeepSeek rendered tool-call JSON or tags as assistant text"));
  // The leaked markup shows as ESCAPED text - the literal tag is in the DOM text, and no live
  // <tool_call> element was created by a markdown/HTML parser.
  assert.match(container.textContent ?? "", /<tool_call>/);
  assert.equal(container.querySelector("tool_call"), null);
});

test("an ordinary assistant message still renders as markdown (anomaly path untouched)", () => {
  const { container } = renderRow(assistant({ text: "# Heading\n\nplain answer" }));
  // A real markdown heading element is produced; no anomaly alert appears.
  assert.ok(container.querySelector("h1"));
  assert.equal(screen.queryByText("provider protocol anomaly"), null);
});

test("an assistant transcript message routes explicit Mermaid diagrams inline", () => {
  renderRow(
    assistant({
      text: `Here is the flow:

\`\`\`mermaid
graph TD
  A-->B
\`\`\`

\`\`\`ts
const ordinary = true;
\`\`\``,
    }),
  );

  assert.ok(screen.getByTestId("mermaid-block"));
  assert.equal(screen.getByTestId("mermaid-source").textContent, "graph TD\n  A-->B");
  assert.ok(screen.getByText("const ordinary = true;"));
});

test("a user transcript message keeps Mermaid fences as ordinary code", () => {
  const { container } = renderRow(
    userRow({
      kind: "user",
      id: "u-mermaid",
      text: "```mermaid\ngraph TD\n  A-->B\n```",
      artifacts: [],
      pastes: [],
    }),
  );

  assert.equal(screen.queryByTestId("mermaid-block"), null);
  assert.ok(container.querySelector("pre code.language-mermaid"));
});

test("the DeepSeek DSML envelope leak renders as a provider anomaly, escaped", () => {
  // The raw DSML-like tool-call envelope from the original DeepSeek incident, leaked as final text.
  const dsml = [
    "< | | DSML | | tool_calls>",
    '< | | DSML | | invoke name="edit">',
    '< | | DSML | | parameter name="path" string="true">/Users/kevin/dev/app.ts',
    "</ | | DSML | | tool_calls>",
  ].join("\n");
  const { container } = renderRow(
    assistant({
      text: dsml,
      diagnostic: {
        provider: "deepseek",
        phase: "tool-protocol",
        reason: "protocol_anomaly",
        retryable: true,
        safeToRetry: false,
        attempt: 1,
        detail: "DeepSeek rendered tool-call JSON or tags as assistant text",
        partials: { textChars: dsml.length, thinkingChars: 0, toolCalls: 0, toolResults: 0 },
      },
    }),
  );

  assert.ok(screen.getByText("provider protocol anomaly"));
  // The DSML envelope shows as escaped text in a bounded block - the literal markup is present and no
  // invoke/parameter element was materialized by a parser.
  assert.match(container.textContent ?? "", /DSML \| \| tool_calls/);
  assert.equal(container.querySelector("invoke"), null);
  assert.equal(container.querySelector("parameter"), null);
});

test("10-large-paste: a submitted prompt's pasted tokens render an inspect/copy panel", () => {
  const payload = "alpha\nbeta\ngamma";
  const { container } = renderRow(
    userRow({
      kind: "user",
      id: "u1",
      text: "here is the log [Pasted text #1 +3 lines] - thoughts?",
      artifacts: [],
      pastes: [{ text: payload }],
    }),
  );

  // The compact token stays inline in the prose (readable, not flooding).
  assert.match(container.textContent ?? "", /\[Pasted text #1 \+3 lines\]/);
  // The inspect panel shows the disclosure label + counts.
  assert.ok(screen.getByText("Pasted text #1"));
  assert.match(container.textContent ?? "", new RegExp(`3 lines · ${payload.length} chars`));

  // Collapsed by default: the full payload is not shown until expanded.
  assert.equal(container.querySelector("pre"), null, "the payload preview is collapsed by default");
  fireEvent.click(screen.getByText("Pasted text #1"));
  assert.equal(
    container.querySelector("pre")?.textContent,
    payload,
    "expanding reveals the exact payload",
  );
});

test("10-large-paste: the transcript copy action writes the exact pasted payload", () => {
  const writeText = vi.fn();
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const payload = "secret-looking\npasted blob";
  renderRow(
    userRow({
      kind: "user",
      id: "u2",
      text: "[Pasted text #1 +2 lines]",
      artifacts: [],
      pastes: [{ text: payload }],
    }),
  );
  fireEvent.click(screen.getByLabelText("Copy pasted text"));
  assert.equal(writeText.mock.calls[0]?.[0], payload);
  vi.unstubAllGlobals();
});

test("plan 07: a guardrail marker renders quietly with only the tool, reason, and count", () => {
  const { container } = renderRow(
    messageRow({
      kind: "guardrail",
      id: "g1",
      tool: "read",
      action: "warn",
      reason: "no_progress",
      count: 3,
    }),
  );
  assert.match(container.textContent ?? "", /guardrail/i);
  assert.match(container.textContent ?? "", /read/);
  assert.match(container.textContent ?? "", /no progress/i);
  assert.match(container.textContent ?? "", /×3/);
  // A quiet advisory, not the alarming alert card.
  assert.equal(container.querySelector('[role="alert"]'), null);
});

test("plan 07: a blocked guardrail marker names the block", () => {
  const { container } = renderRow(
    messageRow({
      kind: "guardrail",
      id: "g2",
      tool: "bash",
      action: "block",
      reason: "repeated_failure",
      count: 5,
    }),
  );
  assert.match(container.textContent ?? "", /repeated failure/i);
  assert.match(container.textContent ?? "", /blocked/i);
});

test("plan 25 M9: a hook deny renders as a quiet attributed line with tool and reason", () => {
  const { container } = renderRow(
    messageRow({
      kind: "hookDecision",
      id: "hd1",
      hookId: "project:guard",
      event: "PreToolUse",
      decision: "deny",
      toolName: "bash",
      reason: "workspace is read-only",
    }),
  );
  const text = container.textContent ?? "";
  assert.match(text, /hook/i);
  assert.match(text, /project:guard/);
  assert.match(text, /denied bash/);
  assert.match(text, /workspace is read-only/);
  // A quiet advisory line, not the alarming alert card.
  assert.equal(container.querySelector('[role="alert"]'), null);
});

test("plan 25 M9: a Stop halt renders the halted-turn line with its reason", () => {
  const { container } = renderRow(
    messageRow({
      kind: "hookDecision",
      id: "hd2",
      hookId: "user:review",
      event: "Stop",
      decision: "halt",
      reason: "cover the edge case",
    }),
  );
  const text = container.textContent ?? "";
  assert.match(text, /user:review/);
  assert.match(text, /halted the turn/i);
  assert.match(text, /cover the edge case/);
});

test("plan 25 M9: a hook context note renders attributed to its tool", () => {
  const { container } = renderRow(
    messageRow({
      kind: "hookDecision",
      id: "hd3",
      hookId: "project:note",
      event: "PreToolUse",
      decision: "context",
      toolName: "read",
      reason: "prefer the v2 config",
    }),
  );
  const text = container.textContent ?? "";
  assert.match(text, /project:note/);
  assert.match(text, /context for read/i);
  assert.match(text, /prefer the v2 config/);
});
