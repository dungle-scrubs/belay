import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { test, vi } from "vitest";
import { TangentShell, type TangentTurn } from "./tangent-shell";

/**
 * M4 tangent takeover shell: presentational interaction tests. The shell reads as a separate side
 * conversation (labelled source header + its own composer), returns via the back arrow, sends into the
 * tangent, and offers an EXPLICIT fold-back per assistant reply. Runs in the `web` jsdom project.
 */

const SEED = "blobs are content-addressed by sha256";

const CONVERSATION: TangentTurn[] = [
  { id: "u1", role: "user", text: "why sha256?" },
  { id: "a1", role: "assistant", text: "content addressing dedupes identical bytes" },
];

function renderShell(over: Partial<Parameters<typeof TangentShell>[0]> = {}) {
  const onBack = vi.fn();
  const onSend = vi.fn();
  const onDraftChange = vi.fn();
  render(
    <TangentShell
      sourceQuote={SEED}
      parentLabel="Blob store design"
      turns={CONVERSATION}
      composer={{ draft: "", onDraftChange, onSend }}
      onBack={onBack}
      {...over}
    />,
  );
  return { onBack, onSend, onDraftChange };
}

test("renders the source quote header so the takeover reads as a scoped side conversation", () => {
  renderShell();
  assert.ok(screen.getByText(SEED));
  assert.ok(screen.getByText(/from Blob store design/));
});

test("the back arrow returns to the parent chat", () => {
  const { onBack } = renderShell();
  fireEvent.click(screen.getByLabelText("Back to conversation"));
  assert.equal(onBack.mock.calls.length, 1);
});

test("Send publishes into the tangent composer", () => {
  const onSend = vi.fn();
  render(
    <TangentShell
      sourceQuote={SEED}
      turns={CONVERSATION}
      composer={{ draft: "hi", onDraftChange: vi.fn(), onSend }}
      onBack={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText("Send"));
  assert.equal(onSend.mock.calls.length, 1);
});

test("Enter sends, and a disabled composer blocks send", () => {
  const onSend = vi.fn();
  renderShell({ composer: { draft: "ask", onDraftChange: vi.fn(), onSend } });
  const textarea = screen.getByPlaceholderText("Ask in this tangent…");
  fireEvent.keyDown(textarea, { key: "Enter" });
  assert.equal(onSend.mock.calls.length, 1);

  const onSendDisabled = vi.fn();
  render(
    <TangentShell
      sourceQuote={SEED}
      turns={[]}
      composer={{ draft: "x", onDraftChange: vi.fn(), onSend: onSendDisabled, disabled: true }}
      onBack={vi.fn()}
    />,
  );
  fireEvent.click(screen.getAllByText("Send")[1] as HTMLElement);
  assert.equal(onSendDisabled.mock.calls.length, 0);
});

test("the empty state invites a first isolated question", () => {
  renderShell({ turns: [] });
  assert.ok(screen.getByText(/isolated from the parent conversation/));
});

test("a creation error takes over the transcript region", () => {
  renderShell({ turns: [], error: "store unreachable" });
  assert.ok(screen.getByText("Couldn't open the tangent"));
  assert.ok(screen.getByText("store unreachable"));
});

test("fold-back is an explicit per-assistant action carrying that reply's text (M8)", () => {
  const onFoldBack = vi.fn();
  renderShell({ onFoldBack });
  fireEvent.click(screen.getByText("Fold back to parent"));
  assert.deepEqual(onFoldBack.mock.calls[0]?.[0], {
    mode: "message",
    text: "content addressing dedupes identical bytes",
  });
});

test("no fold-back affordance is shown when fold-back is not offered", () => {
  renderShell();
  assert.equal(screen.queryByText("Fold back to parent"), null);
});

test("a fold-back note is shown as visible, reviewable feedback", () => {
  renderShell({
    onFoldBack: vi.fn(),
    foldBackNote: { tone: "success", text: "Sent to the parent composer for review." },
  });
  assert.ok(screen.getByText("Sent to the parent composer for review."));
});

test("the header uses a bright tangent badge and busy copy is concise", () => {
  renderShell({ busy: true });
  assert.ok(screen.getByText("TANGENT"));
  assert.ok(screen.getAllByText("Working...").length > 0);
  assert.equal(screen.queryByText("Working in the tangent"), null);
});
