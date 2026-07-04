import assert from "node:assert/strict";
import { answerProvider, publishTurnVia, transportEmit } from "@trevor/agent-host/testing";
import type { RunningServer } from "@trevor/server-kit";
import {
  decodeTrevorEvent,
  freshSessionId,
  PRODUCER_IDS,
  planTangent,
  type SessionEvent,
  seedTangentPrompt,
  events as sessionEvents,
  streamTransport,
} from "@trevor/session";
import { subscribe, waitFor } from "@trevor/test-kit";
import { bootStore } from "@trevor/test-kit/boot";
import { afterAll, beforeAll, test } from "vitest";

/**
 * S-E2E tangents (plan 37, M9), hermetic: drives the whole tangent flow through a REAL session-store with
 * the deterministic fake provider - create an isolated tangent from a selection, run an isolated turn on
 * it, and record an explicit fold-back - then proves the PARENT session stays intact throughout. This is
 * the end-to-end guarantee behind the isolation contract: a tangent runs on its OWN log and fold-back is a
 * durable marker on the tangent, never a write into the parent (the reviewable text lands in the parent
 * COMPOSER, covered by the web tests).
 */

let store: RunningServer;

beforeAll(async () => {
  store = await bootStore();
});

afterAll(async () => {
  await store.close();
});

async function readLog(url: string, sessionId: string): Promise<readonly SessionEvent[]> {
  const transport = streamTransport(url);
  const viewer = subscribe(transport, sessionId, `reader-${sessionId}`);
  await waitFor(viewer.isReplayed, { label: `${sessionId} replay` });
  viewer.connection.close();
  return viewer.events;
}

test("create -> isolated chat -> fold-back keeps the parent transcript intact", async () => {
  const transport = streamTransport(store.url);
  const parent = "tangent-parent";
  await transport.ensureSession(parent);

  // A parent transcript the tangent must NOT inherit.
  await transport.publishEvent(parent, {
    ...sessionEvents.userMessage({ text: "explain the blob store secret", provider: "lmstudio" }),
    producerId: PRODUCER_IDS.web,
  });
  await transport.publishEvent(parent, {
    ...sessionEvents.assistantCompleted({
      runId: "pr1",
      text: "blobs are content-addressed by sha256 - parent conclusion",
    }),
    producerId: PRODUCER_IDS.host,
  });
  const parentBefore = await readLog(store.url, parent);

  // Create the tangent from the selected snapshot (the assistant's sha256 line) - marker only, no copy.
  const quote = "blobs are content-addressed by sha256";
  const tangentSessionId = freshSessionId({ prefix: "tangent" });
  const plan = planTangent({
    anchor: { parentSessionId: parent, sourceMessageId: "p-e2", quote },
    tangentSessionId,
  });
  await transport.ensureSession(tangentSessionId);
  for (const input of plan.events) {
    await transport.publishEvent(tangentSessionId, input);
  }

  const viewer = subscribe(transport, tangentSessionId, "tangent-viewer");
  await waitFor(viewer.isReplayed);

  // The tangent's first prompt folds the seed in; publish it (web producer) + run an ISOLATED turn.
  const firstPrompt = seedTangentPrompt(quote, "why sha256 and not a uuid?");
  await transport.publishEvent(tangentSessionId, {
    ...sessionEvents.userMessage({ text: firstPrompt, provider: "lmstudio" }),
    producerId: PRODUCER_IDS.web,
  });
  await publishTurnVia(
    transportEmit(transport, tangentSessionId, "host"),
    answerProvider("content addressing keeps storage idempotent"),
    [{ role: "user", content: firstPrompt }],
    { runId: "tr1" },
  );
  await waitFor(() => viewer.events.some((e) => e.type === "assistant.completed"), {
    label: "tangent completed",
  });

  const tangentLog = viewer.events;
  // The tangent ran its OWN turn: lineage marker + the seeded prompt + an assistant reply.
  assert.ok(tangentLog.some((e) => e.type === "session.tangentOf"));
  const prompt = tangentLog.find((e) => e.type === "user.message");
  assert.equal((prompt?.payload as { text?: string }).text, firstPrompt);
  const completed = tangentLog.find((e) => e.type === "assistant.completed");
  assert.ok(String(completed?.payload.text ?? "").includes("idempotent"));

  // Isolation: the parent's OTHER transcript never appears anywhere in the tangent log.
  const tangentText = JSON.stringify(tangentLog);
  assert.ok(!tangentText.includes("parent conclusion"), "no parent assistant text leaked");
  assert.ok(!tangentText.includes("explain the blob store secret"), "no parent prompt leaked");

  // Parent stays intact: the isolated chat never wrote to the parent log.
  const parentAfterChat = await readLog(store.url, parent);
  assert.equal(
    parentAfterChat.length,
    parentBefore.length,
    "the tangent chat leaves the parent log unchanged",
  );

  // Explicit fold-back (M8): the durable marker is recorded ON THE TANGENT, never the parent - the
  // reviewable text lands in the parent COMPOSER (web), so the parent LOG is never injected into.
  const replyText = String(completed?.payload.text ?? "");
  await transport.publishEvent(tangentSessionId, {
    ...sessionEvents.tangentFoldedBack({
      tangentSessionId,
      parentSessionId: parent,
      mode: "message",
      preview: replyText.slice(0, 50),
    }),
    producerId: PRODUCER_IDS.web,
  });
  await waitFor(() => viewer.events.some((e) => e.type === "tangent.foldedBack"), {
    label: "fold-back recorded",
  });
  const foldEvent = viewer.events.find((e) => e.type === "tangent.foldedBack");
  const decoded = foldEvent ? decodeTrevorEvent(foldEvent) : null;
  assert.equal(decoded?.type, "tangent.foldedBack");

  // Parent STILL intact after fold-back: fold-back is composer-only, never a parent-log write.
  const parentAfterFold = await readLog(store.url, parent);
  assert.equal(
    parentAfterFold.length,
    parentBefore.length,
    "fold-back never writes to the parent log",
  );
  assert.ok(!parentAfterFold.some((e) => e.type === "tangent.foldedBack"));

  viewer.connection.close();
});
