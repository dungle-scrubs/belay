import assert from "node:assert/strict";
import { type SessionEvent, streamTransport } from "@trevor/session";
import { testIdentity, waitFor } from "@trevor/test-kit";
import { test } from "vitest";

/**
 * Live lane (gated): multi-turn context against a RUNNING host on a real model. Ask it to
 * remember a value, then in a second turn ask it to recall - the recall only works if the host
 * projects prior turns back as context. Ported from scripts/verify-context.mjs. Skips with a
 * stated reason unless the live host env is configured.
 */

const base = process.env.RICHTER_URL;
const sid = process.env.SESSION_ID;
const provider = process.env.PROVIDER_KEY ?? "gpt";
const enabled = process.env.TREVOR_LIVE === "1" && Boolean(base) && Boolean(sid);

test.skipIf(!enabled)(
  "live: context is retained across turns",
  async () => {
    const transport = streamTransport(base as string);
    const events: SessionEvent[] = [];
    let hostOnline = false;
    const conn = transport.connectSession({
      sessionId: sid as string,
      identity: testIdentity("verify", "web"),
      onEvent: (e) => {
        if (e.type === "host.online") hostOnline = true;
        events.push(e);
      },
    });
    await waitFor(() => hostOnline, { timeoutMs: 60_000, label: "host.online" });

    async function ask(text: string): Promise<string> {
      const mark = events.length;
      await transport.publishEvent(sid as string, {
        type: "user.message",
        producerId: "verify",
        payload: { text, provider },
      });
      await waitFor(() => events.slice(mark).some((e) => e.type === "assistant.completed"), {
        timeoutMs: 180_000,
        label: "turn completion",
      });
      const completed = events.slice(mark).find((e) => e.type === "assistant.completed");
      return String(completed?.payload.text ?? "");
    }

    await ask("Remember the number 42. Reply with just: OK");
    const turn2 = await ask("What number did I ask you to remember? Reply with just the number.");
    conn.close();

    assert.ok(turn2.includes("42"), `turn 2 did not recall 42: "${turn2.trim().slice(0, 60)}"`);
  },
  260_000,
);
