import assert from "node:assert/strict";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type SessionEvent, events as sessionEvents, type TrevorEventInput } from "@trevor/session";
import { recordingTransport } from "@trevor/test-kit";
import { test, vi } from "vitest";
import { LiveTangentShell } from "./live-tangent-shell";
import type { ActiveTangent } from "./use-tangent";

/**
 * M6 tangent chat isolation (live wiring): the tangent shell binds its OWN session stream + actions to the
 * tangent id, so a send publishes into the TANGENT (never the parent) and the tangent transcript comes from
 * the tangent's own log. Fold-back (M8) is an explicit per-reply action. Runs in the `web` jsdom project.
 */

const QUOTE = "blobs are content-addressed by sha256";
const ACTIVE: ActiveTangent = {
  tangentSessionId: "tangent-1",
  parentSessionId: "parent",
  sourceMessageId: "parent-e2",
  quote: QUOTE,
};

let seq = 0;
function stored(input: TrevorEventInput, producerId = "trevor-web"): SessionEvent {
  seq += 1;
  return {
    sessionId: "tangent-1",
    seq,
    eventId: `e${seq}`,
    producerId,
    createdAt: "2026-07-04T00:00:00.000Z",
    type: input.type,
    payload: input.payload,
  };
}

test("a tangent send publishes the seeded first prompt into the TANGENT, never the parent (M6)", async () => {
  seq = 0;
  const rec = recordingTransport();
  rec.seed("tangent-1", [
    stored(
      sessionEvents.sessionTangentOf({
        parentSessionId: "parent",
        sourceMessageId: "parent-e2",
        quote: QUOTE,
      }),
    ),
  ]);

  render(
    <LiveTangentShell
      active={ACTIVE}
      error={null}
      parentLabel="Blob store design"
      turnModel={{ provider: "lmstudio" }}
      onBack={vi.fn()}
      onFoldBack={vi.fn()}
      transport={rec.transport}
    />,
  );

  const textarea = await screen.findByPlaceholderText("Ask in this tangent…");
  fireEvent.change(textarea, { target: { value: "why sha256?" } });
  fireEvent.click(screen.getByText("Send"));

  await waitFor(() => assert.ok(rec.publishedBy("tangent-1").length > 0));
  const published = rec.publishedBy("tangent-1");
  const prompt = published.find((e) => e.type === "user.message");
  assert.ok(prompt, "a user.message was published to the tangent");
  // The FIRST prompt folds the seed snapshot in.
  assert.equal((prompt?.payload as { text?: string }).text, `> ${QUOTE}\n\nwhy sha256?`);
  assert.equal((prompt?.payload as { provider?: string }).provider, "lmstudio");
  // Isolation: nothing was published into the parent session.
  assert.deepEqual(rec.publishedBy("parent"), [], "the parent transcript is never written to");
});

function seedTangent(rec: ReturnType<typeof recordingTransport>, extra: SessionEvent[] = []): void {
  rec.seed("tangent-1", [
    stored(
      sessionEvents.sessionTangentOf({
        parentSessionId: "parent",
        sourceMessageId: "parent-e2",
        quote: QUOTE,
      }),
    ),
    ...extra,
  ]);
}

test("Escape while a tangent turn is running hard-cancels it (user.cancel), never closes it", async () => {
  seq = 0;
  const rec = recordingTransport();
  // A trailing user turn with no reply yet = busy (the turn is running / awaiting the host's answer).
  seedTangent(rec, [
    stored(sessionEvents.userMessage({ text: `> ${QUOTE}\n\ngo`, provider: "lmstudio" })),
  ]);
  const onBack = vi.fn();
  render(
    <LiveTangentShell
      active={ACTIVE}
      error={null}
      turnModel={{ provider: "lmstudio" }}
      onBack={onBack}
      onFoldBack={vi.fn()}
      escapeOwned
      transport={rec.transport}
    />,
  );
  // Wait until the shell has replayed: the stripped prompt renders and, with no reply yet, it is busy.
  await screen.findByText("go");

  fireEvent.keyDown(document.body, { key: "Escape" });

  await waitFor(() =>
    assert.ok(rec.publishedBy("tangent-1").some((e) => e.type === "user.cancel")),
  );
  assert.equal(onBack.mock.calls.length, 0, "a running turn is cancelled, not closed");
});

test("Escape with no tangent turn running closes the takeover", async () => {
  seq = 0;
  const rec = recordingTransport();
  seedTangent(rec);
  const onBack = vi.fn();
  render(
    <LiveTangentShell
      active={ACTIVE}
      error={null}
      turnModel={{ provider: "lmstudio" }}
      onBack={onBack}
      onFoldBack={vi.fn()}
      escapeOwned
      transport={rec.transport}
    />,
  );
  await screen.findByText("A fresh tangent from your selection.");

  fireEvent.keyDown(document.body, { key: "Escape" });

  await waitFor(() =>
    assert.equal(onBack.mock.calls.length, 1, "an idle tangent closes on Escape"),
  );
  assert.deepEqual(
    rec.publishedBy("tangent-1").filter((e) => e.type === "user.cancel"),
    [],
    "nothing was cancelled",
  );
});

test("Escape does nothing when the tangent is not the frontmost surface (escapeOwned=false)", async () => {
  seq = 0;
  const rec = recordingTransport();
  seedTangent(rec);
  const onBack = vi.fn();
  render(
    <LiveTangentShell
      active={ACTIVE}
      error={null}
      turnModel={{ provider: "lmstudio" }}
      onBack={onBack}
      onFoldBack={vi.fn()}
      transport={rec.transport}
    />,
  );
  await screen.findByText("A fresh tangent from your selection.");

  fireEvent.keyDown(document.body, { key: "Escape" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    onBack.mock.calls.length,
    0,
    "Escape behind a higher overlay never reaches the tangent",
  );
});

test("with vim enabled, the tangent composer runs the Vim layer; the first Escape enters normal mode, not close", async () => {
  seq = 0;
  const rec = recordingTransport();
  seedTangent(rec);
  const onBack = vi.fn();
  render(
    <LiveTangentShell
      active={ACTIVE}
      error={null}
      turnModel={{ provider: "lmstudio" }}
      onBack={onBack}
      onFoldBack={vi.fn()}
      escapeOwned
      vimEnabled
      transport={rec.transport}
    />,
  );
  const textarea = await screen.findByPlaceholderText("Ask in this tangent…");
  textarea.focus();

  // First Escape in insert mode: the Vim layer consumes it (-> normal) and stops propagation, so the
  // takeover's own Escape (cancel/close) is NOT reached on the first press.
  fireEvent.keyDown(textarea, { key: "Escape" });
  assert.ok(screen.getByLabelText("Vim mode: normal"), "the composer entered Vim normal mode");
  assert.equal(
    onBack.mock.calls.length,
    0,
    "the first Escape enters normal mode, it does not close",
  );
});

test("fold-back offers a specific assistant reply back to the parent, explicitly (M8)", async () => {
  seq = 0;
  const rec = recordingTransport();
  rec.seed("tangent-1", [
    stored(
      sessionEvents.sessionTangentOf({
        parentSessionId: "parent",
        sourceMessageId: "parent-e2",
        quote: QUOTE,
      }),
    ),
    stored(sessionEvents.userMessage({ text: `> ${QUOTE}\n\nwhy?`, provider: "lmstudio" })),
    stored(
      sessionEvents.assistantCompleted({ runId: "r1", text: "content addressing dedupes bytes" }),
      "trevor-host",
    ),
  ]);

  const onFoldBack = vi.fn().mockResolvedValue(undefined);
  render(
    <LiveTangentShell
      active={ACTIVE}
      error={null}
      turnModel={{ provider: "lmstudio" }}
      onBack={vi.fn()}
      onFoldBack={onFoldBack}
      transport={rec.transport}
    />,
  );

  const foldButton = await screen.findByText("Fold back to parent");
  fireEvent.click(foldButton);
  assert.deepEqual(onFoldBack.mock.calls[0]?.[1], {
    mode: "message",
    text: "content addressing dedupes bytes",
  });
  // A visible, reviewable confirmation - never a silent merge.
  await screen.findByText(/review it there before sending/);
});

test("a creation error shows the takeover error state and disables the composer", () => {
  seq = 0;
  const rec = recordingTransport();
  const creating: ActiveTangent = { ...ACTIVE, tangentSessionId: null };
  render(
    <LiveTangentShell
      active={creating}
      error="store unreachable"
      turnModel={{ provider: "lmstudio" }}
      onBack={vi.fn()}
      onFoldBack={vi.fn()}
      transport={rec.transport}
    />,
  );
  assert.ok(screen.getByText("Couldn't open the tangent"));
  assert.ok(screen.getByText("store unreachable"));
});
