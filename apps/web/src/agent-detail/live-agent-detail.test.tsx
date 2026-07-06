import assert from "node:assert/strict";
import { render, screen, waitFor } from "@testing-library/react";
import { type SessionEvent, events as sessionEvents, type TrevorEventInput } from "@trevor/session";
import { recordingTransport } from "@trevor/test-kit";
import { test } from "vitest";
import { LiveAgentDetail } from "./live-agent-detail";

/**
 * Plan 09.4 M6 (live wiring): the inline-agent detail binds a SECOND session stream to the delegated
 * CHILD id, so the takeover renders the child's OWN transcript from the child's OWN log - and a later
 * child event streams in, since the child is a real session in the same store. Runs in the web jsdom
 * project.
 */

let seq = 0;
function stored(input: TrevorEventInput, producerId = "trevor-host"): SessionEvent {
  seq += 1;
  return {
    sessionId: "s::sub::a",
    seq,
    eventId: `e${seq}`,
    producerId,
    createdAt: "2026-07-05T00:00:00.000Z",
    type: input.type,
    payload: input.payload,
  };
}

test("LiveAgentDetail binds the child session and renders its live transcript (M6)", async () => {
  seq = 0;
  const rec = recordingTransport();
  rec.seed("s::sub::a", [
    stored(
      sessionEvents.userMessage({ text: "search for the failing assertion", provider: "qwen" }),
    ),
    stored(
      sessionEvents.assistantStarted({
        runId: "cr1",
        warm: true,
        model: "qwen3",
        provider: "qwen",
      }),
    ),
    stored(sessionEvents.assistantCompleted({ runId: "cr1", text: "Found it in src/auth.ts:42." })),
  ]);

  render(
    <LiveAgentDetail
      childSessionId="s::sub::a"
      agent="explorer"
      onBack={() => {}}
      onOpenPath={() => {}}
      transport={rec.transport}
    />,
  );

  // The child's OWN transcript renders from the child's OWN log (replay-then-tail).
  await waitFor(() => assert.ok(screen.getByText(/Found it in src\/auth\.ts:42/)));
  assert.ok(screen.getByText("search for the failing assertion"), "the child's task prompt");
  assert.ok(screen.getByText(/explorer/), "the header names the agent");
});
