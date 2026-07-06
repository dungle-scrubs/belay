import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import { test } from "vitest";
import { inlineAgent } from "./inline-agent-fixtures";
import { InlineAgentGroup, InlineAgentRow } from "./inline-agent-row";

/**
 * Plan 09.4 M1: the inline-agent transcript row. Pins the one-line contract (`◆ agent · model ·
 * thinking · (elapsed · ↓ tokens)`), the bare-vs-grouped `└` layout, the four status tones, the
 * compact variant (drops the thinking cell), the running-only shimmer/elapsed, and the click that
 * opens the child transcript - so the row stays a compact, truthful surface distinct from a tool card.
 */

test("a single running agent renders the row contract as a bare row", () => {
  const { container, queryByText } = render(
    <InlineAgentRow agent={inlineAgent({ startedAt: Date.now() - 12_000 })} />,
  );
  const text = container.textContent ?? "";
  assert.match(text, /explorer/); // agent
  assert.match(text, /qwen3-coder-30b/); // model
  assert.match(text, /thinking/); // reasoning cell
  assert.match(text, /\d+s/); // live elapsed
  assert.match(text, /↓ 1\.2k tokens/); // token cell
  // Bare (single) row: no tree branch, and it is NOT the bordered alert card the old block used.
  assert.equal(queryByText("└"), null);
  assert.match(text, /◆/); // the distinct agent glyph a tool row never renders
});

test("the row is not a bordered alert card (distinct from the delegation block / tool card)", () => {
  const { queryByRole } = render(<InlineAgentRow agent={inlineAgent()} />);
  assert.equal(queryByRole("alert"), null);
});

test("full variant shows the thinking cell; compact drops it but keeps the model", () => {
  const full = render(<InlineAgentRow agent={inlineAgent()} variant="full" />);
  assert.match(full.container.textContent ?? "", /thinking/);
  const compact = render(<InlineAgentRow agent={inlineAgent()} variant="compact" />);
  const text = compact.container.textContent ?? "";
  assert.doesNotMatch(text, /thinking/);
  assert.match(text, /qwen3-coder-30b/);
});

test("done tone is green, carries final tokens, and shows no live elapsed", () => {
  const { getByText, container } = render(
    <InlineAgentRow agent={inlineAgent({ status: "done", startedAt: undefined, tokens: 4200 })} />,
  );
  assert.match(getByText("explorer").className, /text-smui-green/);
  const text = container.textContent ?? "";
  assert.match(text, /↓ 4\.2k tokens/);
  assert.doesNotMatch(text, /\(\d/); // the parenthetical does not open with a digit (no elapsed cell)
});

test("failed tone is red and names the terminal state", () => {
  const { getByText, container } = render(
    <InlineAgentRow agent={inlineAgent({ status: "failed", startedAt: undefined })} />,
  );
  assert.match(getByText("explorer").className, /text-smui-red/);
  assert.match(container.textContent ?? "", /failed/);
});

test("interrupted tone is yellow and names the terminal state", () => {
  const { getByText, container } = render(
    <InlineAgentRow
      agent={inlineAgent({ status: "interrupted", startedAt: undefined, tokens: undefined })}
    />,
  );
  assert.match(getByText("explorer").className, /text-smui-yellow/);
  assert.match(container.textContent ?? "", /interrupted/);
});

test("a running row shimmers the agent name; a terminal row does not", () => {
  const running = render(<InlineAgentRow agent={inlineAgent({ status: "running" })} />);
  assert.ok(running.container.querySelector(".shimmer"), "running row shimmers");
  const done = render(
    <InlineAgentRow agent={inlineAgent({ status: "done", startedAt: undefined })} />,
  );
  assert.equal(done.container.querySelector(".shimmer"), null);
});

test("a single-agent group collapses to a bare row (no header, no branch)", () => {
  const { container, queryByText } = render(<InlineAgentGroup agents={[inlineAgent()]} />);
  const text = container.textContent ?? "";
  assert.doesNotMatch(text, /agents/); // no "N agents" header
  assert.equal(queryByText("└"), null);
  assert.match(text, /explorer/);
});

test("parallel agents group under a header with the └ tree branch", () => {
  const { container } = render(
    <InlineAgentGroup
      agents={[
        inlineAgent({ childSessionId: "s::sub::a", agent: "explorer" }),
        inlineAgent({ childSessionId: "s::sub::b", agent: "planner", status: "done" }),
        inlineAgent({ childSessionId: "s::sub::c", agent: "reviewer" }),
      ]}
    />,
  );
  const text = container.textContent ?? "";
  assert.match(text, /3 agents/); // the group header
  assert.match(text, /explorer/);
  assert.match(text, /planner/);
  assert.match(text, /reviewer/);
  // Exactly one `└` (the first row anchors the branch; the rest align beneath).
  assert.equal((text.match(/└/g) ?? []).length, 1);
});

test("a clickable row fires onOpen with the child session id", () => {
  let opened: string | null = null;
  const { getByRole } = render(
    <InlineAgentRow
      agent={inlineAgent({ childSessionId: "s::sub::zzz" })}
      onOpen={(id) => {
        opened = id;
      }}
    />,
  );
  fireEvent.click(getByRole("button"));
  assert.equal(opened, "s::sub::zzz");
});

test("a large parallel group auto-compacts, dropping the thinking cell (09.4)", () => {
  // The fixture carries reasoningLevel "thinking"; a group of >=4 agents switches to the compact
  // variant (drops that cell) so a wide group stays scannable, while a small group keeps it.
  const many = ["a", "b", "c", "d"].map((id) =>
    inlineAgent({ childSessionId: `s::sub::${id}`, agent: `agent-${id}`, status: "running" }),
  );
  const big = render(<InlineAgentGroup agents={many} />);
  assert.doesNotMatch(big.container.textContent ?? "", /thinking/, "4 agents -> compact");
  const small = render(<InlineAgentGroup agents={many.slice(0, 2)} />);
  assert.match(small.container.textContent ?? "", /thinking/, "2 agents -> full");
});
