import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ProviderQuestionAnswer } from "@trevor/session";
import { test, vi } from "vitest";
import * as fx from "./fixtures";
import { QuestionSurface } from "./question-surface";

/**
 * Plan 26 M7 (D-010/D-012): a CLAUDE.md migration proposal rides the provider-question surface, so it
 * renders through the shared QuestionSurface. These tests prove a proposal shows the paths, the sibling
 * state, a bounded preview, and the explicit per-file action controls, and that choosing an action emits
 * the wire answer the host resolves into a decision (the choice id is the action).
 */

function renderProposal(contract: Parameters<typeof QuestionSurface>[0]["contract"]) {
  const onAnswer = vi.fn<(a: ProviderQuestionAnswer) => void>();
  render(<QuestionSurface contract={contract} onAnswer={onAnswer} />);
  return { onAnswer };
}

test("a create proposal shows the paths, sibling state, bounded preview, and action controls", () => {
  renderProposal(fx.claudeMigration);

  // Paths + sibling state + preview are all surfaced in the question text.
  assert.ok(screen.getByText(/Migrate CLAUDE\.md to AGENTS\.md\?/));
  assert.ok(screen.getByText(/No sibling AGENTS\.md exists yet/));
  assert.ok(screen.getByText(/always run the linter/i));

  // The four explicit actions render as selectable controls.
  for (const label of [
    "Create AGENTS.md",
    "Leave unchanged",
    "Ignore once",
    "Ignore permanently",
  ]) {
    assert.ok(screen.getByRole("radio", { name: new RegExp(label) }), `${label} is a control`);
  }
  // Create is the recommended default, so it opens selected.
  assert.equal(
    screen.getByRole("radio", { name: /Create AGENTS\.md/ }).getAttribute("aria-checked"),
    "true",
  );
});

test("choosing an action emits the wire answer whose selected id is the action", () => {
  const { onAnswer } = renderProposal(fx.claudeMigration);

  fireEvent.click(screen.getByRole("radio", { name: /Ignore permanently/ }));
  fireEvent.click(screen.getByRole("button", { name: /submit answer/i }));

  const answer = onAnswer.mock.calls.at(-1)?.[0];
  assert.ok(answer && answer.action === "accept");
  assert.deepEqual(answer.questions[0]?.selected, [
    { id: "ignore-permanent", label: "Ignore permanently" },
  ]);
});

test("a proposal with an existing sibling offers merge as the recommended action", () => {
  renderProposal(fx.claudeMigrationWithSibling);

  assert.ok(screen.getByText(/A sibling apps\/web\/AGENTS\.md already exists/));
  const merge = screen.getByRole("radio", { name: /Merge into existing AGENTS\.md/ });
  assert.equal(merge.getAttribute("aria-checked"), "true", "merge is the recommended default");
  assert.equal(
    screen.queryByRole("radio", { name: /Create AGENTS\.md/ }),
    null,
    "create is not offered",
  );
});
