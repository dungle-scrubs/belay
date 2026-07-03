import assert from "node:assert/strict";
import { streamTransport } from "@trevor/session";
import { liveHost } from "@trevor/test-kit";
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
    const host = liveHost(transport, sid as string, { provider });
    await host.waitHostOnline();

    await host.ask("Remember the number 42. Reply with just: OK", { label: "turn 1 completion" });
    const turn2 = await host.ask(
      "What number did I ask you to remember? Reply with just the number.",
      {
        label: "turn 2 completion",
      },
    );
    host.close();

    assert.ok(
      turn2.text.includes("42"),
      `turn 2 did not recall 42: "${turn2.text.trim().slice(0, 60)}"`,
    );
  },
  260_000,
);
