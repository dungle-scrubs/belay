import assert from "node:assert/strict";
import type { SessionEvent } from "@trevor/session";
import { test } from "vitest";
import { nextTangentPrompt, tangentHasUserTurn, tangentTurns } from "./tangent-send";

/**
 * M6 tangent chat isolation (pure helpers): the tangent transcript is projected from its OWN log, and the
 * first prompt folds the seed selection in while later prompts stay plain. Runs in the `web` project.
 */

let seq = 0;
function ev(type: string, payload: Record<string, unknown>): SessionEvent {
  seq += 1;
  return {
    sessionId: "tangent",
    seq,
    eventId: `e${seq}`,
    producerId: "trevor-web",
    createdAt: "2026-07-04T00:00:00.000Z",
    type,
    payload,
  };
}

test("tangentTurns projects the tangent's own user/assistant turns", () => {
  seq = 0;
  const turns = tangentTurns([
    ev("session.tangentOf", { parentSessionId: "p", sourceMessageId: "e2", quote: "q" }),
    ev("user.message", { text: "> q\n\nwhy sha256?", provider: "lmstudio" }),
    ev("assistant.completed", { runId: "r1", text: "content addressing dedupes" }),
  ]);
  assert.deepEqual(
    turns.map((t) => ({ role: t.role, text: t.text })),
    [
      { role: "user", text: "> q\n\nwhy sha256?" },
      { role: "assistant", text: "content addressing dedupes" },
    ],
  );
});

test("the first prompt folds the seed snapshot in; later prompts are plain (M6)", () => {
  const quote = "blobs are content-addressed by sha256";
  // No user turn yet: fold the seed into the opening prompt.
  assert.equal(
    nextTangentPrompt([], quote, "why sha256?"),
    "> blobs are content-addressed by sha256\n\nwhy sha256?",
  );
  // After a first user turn exists, subsequent prompts are the plain draft.
  const withUser = [{ id: "u1", role: "user" as const, text: "> q\n\nwhy sha256?" }];
  assert.equal(nextTangentPrompt(withUser, quote, "and collisions?"), "and collisions?");
  assert.equal(tangentHasUserTurn(withUser), true);
  assert.equal(tangentHasUserTurn([]), false);
});
