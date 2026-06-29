import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { test, vi } from "vitest";
import { HandoffApprovalSurface } from "./HandoffApprovalSurface";

/**
 * The generated-handoff approval surface (02.10, M8): generating shows a spinner with no actions; a
 * generated draft shows the prompt + Approve/Edit/Reject, each wired to its callback. Runs in the jsdom
 * `web` project.
 */

const noop = () => {};

test("generating shows a drafting status and no decision buttons", () => {
  render(
    <HandoffApprovalSurface
      handoff={{ status: "generating", handoffId: "h1" }}
      onApprove={noop}
      onEdit={noop}
      onReject={noop}
    />,
  );
  assert.ok(screen.getByText(/Drafting a handoff prompt/i));
  assert.equal(screen.queryByText("Approve & switch"), null);
  assert.equal(screen.queryByText("Reject"), null);
});

test("a generated draft renders the prompt and the three decisions", () => {
  render(
    <HandoffApprovalSurface
      handoff={{ status: "generated", handoffId: "h1", prompt: "Continue the parser work" }}
      onApprove={noop}
      onEdit={noop}
      onReject={noop}
    />,
  );
  assert.ok(screen.getByText("Continue the parser work"));
  assert.ok(screen.getByText("Approve & switch"));
  assert.ok(screen.getByText("Edit"));
  assert.ok(screen.getByText("Reject"));
});

test("Approve fires onApprove", () => {
  const onApprove = vi.fn();
  render(
    <HandoffApprovalSurface
      handoff={{ status: "generated", handoffId: "h1", prompt: "p" }}
      onApprove={onApprove}
      onEdit={noop}
      onReject={noop}
    />,
  );
  fireEvent.click(screen.getByText("Approve & switch"));
  assert.equal(onApprove.mock.calls.length, 1);
});

test("Edit hands the draft text to onEdit (to seed the prompt editor)", () => {
  const onEdit = vi.fn();
  render(
    <HandoffApprovalSurface
      handoff={{ status: "generated", handoffId: "h1", prompt: "draft to edit" }}
      onApprove={noop}
      onEdit={onEdit}
      onReject={noop}
    />,
  );
  fireEvent.click(screen.getByText("Edit"));
  assert.equal(onEdit.mock.calls[0]?.[0], "draft to edit");
});

test("Reject fires onReject", () => {
  const onReject = vi.fn();
  render(
    <HandoffApprovalSurface
      handoff={{ status: "generated", handoffId: "h1", prompt: "p" }}
      onApprove={noop}
      onEdit={noop}
      onReject={onReject}
    />,
  );
  fireEvent.click(screen.getByText("Reject"));
  assert.equal(onReject.mock.calls.length, 1);
});
