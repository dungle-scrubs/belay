import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ArtifactRef } from "@trevor/session";
import { test, vi } from "vitest";
import { RECOVERY_ACTION_LABEL, reconnectActionLabel } from "@/action-label";
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

test("44.4: an approaching usage-limit renders a QUIET breadcrumb, not an alarming card", () => {
  const { container } = renderRow(
    messageRow({
      kind: "limit",
      id: "lim1",
      provider: "anthropic",
      status: "approaching",
      scope: "five_hour",
    }),
  );
  const text = container.textContent ?? "";
  assert.match(text, /approaching/i);
  assert.match(text, /5h/i);
  // Quiet muted breadcrumb - no alert role (that is reserved for the louder "reached").
  assert.equal(container.querySelector('[role="alert"]'), null);
});

test("44.4: a reached usage-limit renders a LOUDER alert with the humanized reset", () => {
  // resetsAt ~ 2h ahead of the fixed clock the row uses in the test (see limitResetLabel injection).
  const { container } = renderRow(
    messageRow({
      kind: "limit",
      id: "lim2",
      provider: "codex",
      status: "reached",
      scope: "unknown",
    }),
  );
  const text = container.textContent ?? "";
  assert.match(text, /reached/i);
  // The louder treatment uses the alert card (like `recovered`), not the quiet breadcrumb.
  assert.ok(container.querySelector('[role="alert"]'));
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

test("renders a hook_halt stop with its own title (plan 25 simplify C2)", () => {
  renderRow(
    assistant({
      stop: {
        cause: "hook_halt",
        action: "paused",
        summary: 'Completion halted by Stop hook "project:/repo:gate": not yet.',
      },
    }),
  );
  assert.ok(screen.getByText("halted by hook"));
  assert.ok(screen.getByText(/Completion halted by Stop hook/));
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

test("user, shell, and command-result rows share the same transcript block alignment", () => {
  const cases: Array<readonly [string, TranscriptRow]> = [
    ["user1", messageRow({ kind: "user", id: "user1", text: "hello", artifacts: [], pastes: [] })],
    ["res1", messageRow({ kind: "result", id: "res1", command: "/help", text: "ok", ok: true })],
    [
      "shell1",
      messageRow({
        kind: "shell",
        id: "shell1",
        requestId: "rq1",
        command: "git status",
        done: true,
        output: "clean",
        ok: true,
      }),
    ],
  ];

  for (const [id, row] of cases) {
    const view = renderRow(row);
    const block = view.container.querySelector(`[data-message-id="${id}"]`);
    assert.ok(block, `${id} should have a selectable transcript block`);
    assert.ok(block.classList.contains("pl-3.5"), `${id} should use the shared left inset`);
    view.unmount();
  }
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
  // The ordinary ts block is syntax-highlighted (its text is split across token spans), while the
  // mermaid fence keeps its diagram route.
  const tsCode = document.querySelector("pre code.language-ts");
  assert.ok(tsCode?.textContent?.includes("const ordinary = true;"));
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

// --- plan 31 M4 / plan 50: shimmer action status in the live transcript rows ---

/** The shimmer overlay is the aria-hidden `.shimmer` duplicate the ActionShimmer primitive renders. */
function shimmerOverlay(container: HTMLElement): Element | null {
  return container.querySelector("[aria-hidden].shimmer");
}

test("plan 50: a silent warm turn renders NO in-transcript shimmer (the pinned header owns it)", () => {
  // The live "thinking" indicator moved to the ONE pinned TurnStatusHeader, so a silent, reasoning-less
  // in-flight segment renders nothing here rather than a second shimmering indicator (R-4).
  const { container } = renderRow(assistant({ text: "", done: false, warm: true }));
  assert.equal(shimmerOverlay(container), null, "no duplicate live indicator in the transcript");
  assert.doesNotMatch(container.textContent ?? "", /thinking/);
});

test("plan 50: a silent cold turn no longer renders a loading-model shimmer in the transcript", () => {
  const { container } = renderRow(assistant({ text: "", done: false, warm: false, model: "qwen" }));
  assert.equal(shimmerOverlay(container), null);
  assert.doesNotMatch(container.textContent ?? "", /loading qwen/);
});

test("plan 50: a silent turn WITH reasoning tokens still renders the reasoning trace (real content)", () => {
  // Neutralizing the bare shimmer fallback must NOT drop ReasoningTrace - that is actual thinking-token
  // content, not a duplicate live indicator.
  renderRow(assistant({ thinking: "weighing the options", text: "", done: false, warm: true }));
  assert.ok(screen.getByRole("button", { name: /thinking/i }), "reasoning content still renders");
  assert.ok(screen.getByText("weighing the options"));
});

test("plan 31 M4: settled assistant rows never shimmer", () => {
  const { container } = renderRow(assistant({ text: "done reasoning", done: true }));
  assert.equal(shimmerOverlay(container), null);
});

// --- coordinator fix: reconnecting/recovered rows must call the SHARED action-label helpers, not
// hand-roll a parallel copy of their format. Asserting against the live imported value (rather than
// a hardcoded duplicate string) means this test breaks if the row ever stops actually calling the
// shared function - proving there's exactly one source of truth for the format. ---

test("fix: the reconnecting row renders via the shared reconnectActionLabel, not a parallel string", () => {
  const { container } = renderRow(
    messageRow({
      kind: "reconnecting",
      id: "rc1",
      attempt: 2,
      maxAttempts: 5,
      detail: "stream dropped",
    }),
  );
  const text = container.textContent ?? "";
  assert.ok(
    text.includes(reconnectActionLabel(2, 5)),
    "the row's reconnect text must equal whatever the shared helper currently produces",
  );
});

test("fix: the reconnecting row falls back to the legacy attempt budget via the shared helper", () => {
  const { container } = renderRow(
    messageRow({ kind: "reconnecting", id: "rc2", attempt: 1, detail: "stream dropped" }),
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes(reconnectActionLabel(1, 3)), "falls back to LEGACY_RECONNECT_ATTEMPTS=3");
});

test("fix: the recovered row renders via the shared RECOVERY_ACTION_LABEL constant", () => {
  const { container } = renderRow(
    messageRow({
      kind: "recovered",
      id: "rec1",
      action: "trim_tool_result",
      detail: "context pressure eased",
      reclaimed: 0,
    }),
  );
  const text = container.textContent ?? "";
  assert.ok(
    text.includes(RECOVERY_ACTION_LABEL),
    "the row's recovery text must equal whatever the shared constant currently says",
  );
});

// --- plan 34: transcript image rendering wired through the real user-message row ---

const imageArt = (seed: string, name: string): ArtifactRef => ({
  kind: "image",
  mimeType: "image/png",
  size: 10,
  hash: seed.repeat(64).slice(0, 64),
  name,
});

const userMsg = (over: Partial<Extract<Message, { kind: "user" }>>): TranscriptRow =>
  userRow({ kind: "user", id: "iu", text: "", artifacts: [], pastes: [], ...over });

test("plan 34: a prompt keeps its [Image #N] tokens in the visible text while the images render below", () => {
  const { container } = renderRow(
    userMsg({
      id: "iu1",
      text: "the first [Image #1] and the second [Image #2] shots",
      artifacts: [imageArt("a", "first.png"), imageArt("b", "second.png")],
    }),
  );
  // The tokens stay in the prose (they are not stripped when the images render).
  assert.match(container.textContent ?? "", /\[Image #1\]/);
  assert.match(container.textContent ?? "", /\[Image #2\]/);
  // ...and both images render as tiles below.
  assert.equal(container.querySelectorAll("img").length, 2, "an image renders per artifact");
});

test("plan 34: token #k maps to image artifact k - the k-th tile names the k-th artifact", () => {
  renderRow(
    userMsg({
      id: "iu2",
      text: "[Image #1] then [Image #2]",
      artifacts: [imageArt("a", "alpha.png"), imageArt("b", "bravo.png")],
    }),
  );
  assert.ok(
    screen.getByRole("button", { name: "open image 1: alpha.png" }),
    "token #1 -> artifact 1",
  );
  assert.ok(
    screen.getByRole("button", { name: "open image 2: bravo.png" }),
    "token #2 -> artifact 2",
  );
});

// --- plan 35 M3: assistant rows render the ghosted reasoning trace, gated by showThinking ---

/** The reasoning trace's trigger (its accessible name carries the stable `thinking` label). A native
 *  button - distinct from the silent-turn shimmer, which renders "thinking" as a plain span. */
function reasoningTrigger(): HTMLElement {
  return screen.getByRole("button", { name: /thinking/i });
}

test("plan 35 M3: showThinking renders the reasoning trace as a disclosure button", () => {
  renderRow(assistant({ thinking: "weighing the options", text: "the answer", done: true }));
  const btn = reasoningTrigger();
  assert.equal(btn.tagName, "BUTTON");
  assert.ok(screen.getByText("the answer"), "the answer still renders beside the reasoning");
});

test("plan 35 M3: showThinking=false hides the reasoning trace entirely", () => {
  render(
    <TranscriptRowView
      row={assistant({ thinking: "hidden reasoning", text: "the answer", done: true })}
      showThinking={false}
      onOpenPath={noop}
      onDoctorRefresh={noop}
    />,
  );
  assert.equal(screen.queryByRole("button", { name: /thinking/i }), null);
  assert.equal(screen.queryByText("hidden reasoning"), null);
  assert.ok(screen.getByText("the answer"));
});

test("plan 35 M3: a streaming thinking-only turn auto-opens the reasoning trace", () => {
  renderRow(assistant({ thinking: "weighing the options", text: "", done: false }));
  const btn = reasoningTrigger();
  assert.equal(btn.getAttribute("aria-expanded"), "true", "live reasoning auto-opens");
  assert.ok(screen.getByText("weighing the options"), "the streaming reasoning is visible");
});

test("plan 35 M3: a settled answer collapses the reasoning trace but keeps the answer", () => {
  renderRow(assistant({ thinking: "weighing the options", text: "the answer", done: true }));
  assert.equal(
    reasoningTrigger().getAttribute("aria-expanded"),
    "false",
    "settled reasoning collapses so it never competes with the answer",
  );
  assert.ok(screen.getByText("the answer"));
});

test("plan 35 M3: an interrupted assistant row still shows reasoning and the interrupted note", () => {
  renderRow(assistant({ thinking: "partial reasoning", text: "partial", interrupted: true }));
  assert.ok(reasoningTrigger());
  assert.match(screen.getByText(/interrupted/).textContent ?? "", /host restarted/);
});

test("plan 35 M3: an errored assistant row shows reasoning alongside the error alert", () => {
  renderRow(assistant({ thinking: "reasoning before the failure", text: "", error: "boom" }));
  assert.ok(reasoningTrigger());
  assert.ok(screen.getByText("boom"));
});

test("plan 50: with no thinking text a silent turn renders neither a disclosure nor a shimmer", () => {
  const { container } = renderRow(assistant({ thinking: "", text: "", done: false, warm: true }));
  // No reasoning disclosure is rendered when there is no thinking text...
  assert.equal(screen.queryByRole("button", { name: /thinking/i }), null);
  // ...and the retired ActionShimmer fallback no longer duplicates the pinned header's status (R-4).
  assert.equal(
    container.querySelector("[aria-hidden].shimmer"),
    null,
    "no duplicate live indicator",
  );
});

test("plan 34: an image-only prompt renders the image set with no prose block", () => {
  const { container } = renderRow(userMsg({ id: "iu3", artifacts: [imageArt("a", "only.png")] }));
  assert.equal(container.querySelectorAll("img").length, 1, "the image renders");
  assert.equal(container.querySelector("p"), null, "no empty prose paragraph is rendered");
});

test("plan 34: a prompt mixing documents and images shows docs as file rows and only images open the carousel", () => {
  const doc: ArtifactRef = {
    kind: "document",
    mimeType: "application/pdf",
    size: 20,
    hash: "d".repeat(64),
    name: "notes.pdf",
  };
  renderRow(
    userMsg({ id: "iu4", text: "see attached", artifacts: [imageArt("a", "shot.png"), doc] }),
  );
  // The document renders as a quiet file row, never as an image tile.
  assert.ok(screen.getByText("notes.pdf"));
  // Opening the image scopes the carousel to the message's images only - the document is not in it.
  fireEvent.click(screen.getByRole("button", { name: "open image 1: shot.png" }));
  const dialog = screen.getByRole("dialog");
  assert.match(
    dialog.textContent ?? "",
    /Image 1 of 1/,
    "only the one image is in the carousel set",
  );
});

test("09.4 M3: an inlineAgent message routes to the inline-agent group, not a delegation card", () => {
  const row: TranscriptRow = {
    kind: "message",
    id: "message:ia1",
    compactAbove: false,
    message: {
      kind: "inlineAgent",
      id: "ia1",
      parentRunId: "r1",
      agents: [
        { childSessionId: "s::sub::a", agent: "explorer", status: "running", model: "qwen3" },
        { childSessionId: "s::sub::b", agent: "planner", status: "done", tokens: 300 },
      ],
    },
  };
  renderRow(row);
  // "explorer" is running, so its name shimmers (base + aria-hidden overlay = 2 nodes); "planner"
  // is terminal (a single node). Both prove the group rendered its agents.
  assert.ok(screen.getAllByText("explorer").length >= 1);
  assert.ok(screen.getByText("planner"));
  assert.ok(screen.getByText(/2 agents/), "the parallel group header");
  // NOT the purple ToneAlert delegation block (that carries role="alert").
  assert.equal(screen.queryByRole("alert"), null);
});

test("09.4 M3: a background delegation still renders the linked block", () => {
  const row: TranscriptRow = {
    kind: "message",
    id: "message:d1",
    compactAbove: false,
    message: {
      kind: "delegation",
      id: "d1",
      childSessionId: "s::sub::bg",
      agent: "explorer",
      task: "scan the repo",
      mode: "background",
      status: "running",
    },
  };
  renderRow(row);
  assert.ok(screen.getByText(/running in background/), "the async delegation verb");
  assert.ok(screen.getByText("scan the repo"));
});

test("09.4 M6: clicking an inline-agent row fires onOpenAgent with its child session id", () => {
  let opened: string | null = null;
  const row: TranscriptRow = {
    kind: "message",
    id: "message:ia1",
    compactAbove: false,
    message: {
      kind: "inlineAgent",
      id: "ia1",
      parentRunId: "r1",
      agents: [{ childSessionId: "s::sub::zzz", agent: "explorer", status: "done" }],
    },
  };
  render(
    <TranscriptRowView
      row={row}
      showThinking
      onOpenPath={noop}
      onDoctorRefresh={noop}
      onOpenAgent={(id) => {
        opened = id;
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button"));
  assert.equal(opened, "s::sub::zzz");
});
