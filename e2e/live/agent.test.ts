import assert from "node:assert/strict";
import { streamTransport } from "@belay/session";
import { liveHost } from "@belay/test-kit";
import { test } from "vitest";

/**
 * Live lane (gated): against a RUNNING host on a real model, ask it to run a shell command via
 * the bash tool and report the output - passing only if a tool call was emitted AND the final
 * answer contains the command's output (so the loop fed the tool result back). Ported from
 * scripts/verify-agent.mjs. Skips with a stated reason unless the live host env is configured;
 * it never fails the run on a machine without a model. Run: TREVOR_LIVE=1 TETHER_URL=... SESSION_ID=... pnpm test:e2e
 */

const base = process.env.TETHER_URL;
const sid = process.env.SESSION_ID;
const provider = process.env.PROVIDER_KEY ?? "qwen";
const enabled = process.env.TREVOR_LIVE === "1" && Boolean(base) && Boolean(sid);

test.skipIf(!enabled)(
  "live: the agent calls a tool and uses its result",
  async () => {
    const transport = streamTransport(base as string);
    const host = liveHost(transport, sid as string, { provider });
    await host.waitHostOnline();
    const result = await host.ask(
      "Use the bash tool to run the command: echo belay-agent-ok . Then reply with exactly what it printed.",
      {
        label: "assistant.completed",
      },
    );
    host.close();

    const calledTool = result.events.some((e) => e.type === "tool.started");
    assert.ok(calledTool, "expected the agent to call a tool");
    assert.ok(result.text.includes("belay-agent-ok"), result.text);
  },
  200_000,
);
