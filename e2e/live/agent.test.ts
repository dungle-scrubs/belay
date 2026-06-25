import assert from "node:assert/strict";
import { type SessionEvent, streamTransport } from "@trevor/session";
import { testIdentity, waitFor } from "@trevor/test-kit";
import { test } from "vitest";

/**
 * Live lane (gated): against a RUNNING host on a real model, ask it to run a shell command via
 * the bash tool and report the output - passing only if a tool call was emitted AND the final
 * answer contains the command's output (so the loop fed the tool result back). Ported from
 * scripts/verify-agent.mjs. Skips with a stated reason unless the live host env is configured;
 * it never fails the run on a machine without a model. Run: TREVOR_LIVE=1 RICHTER_URL=... SESSION_ID=... pnpm test:e2e
 */

const base = process.env.RICHTER_URL;
const sid = process.env.SESSION_ID;
const provider = process.env.PROVIDER_KEY ?? "qwen";
const enabled = process.env.TREVOR_LIVE === "1" && Boolean(base) && Boolean(sid);

test.skipIf(!enabled)(
  "live: the agent calls a tool and uses its result",
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

    const mark = events.length; // only consider events published after our prompt
    await transport.publishEvent(sid as string, {
      type: "user.message",
      producerId: "verify",
      payload: {
        text: "Use the bash tool to run the command: echo trevor-agent-ok . Then reply with exactly what it printed.",
        provider,
      },
    });

    await waitFor(() => events.slice(mark).some((e) => e.type === "assistant.completed"), {
      timeoutMs: 180_000,
      label: "assistant.completed",
    });
    conn.close();

    const after = events.slice(mark);
    const calledTool = after.some((e) => e.type === "tool.started");
    const completed = after.find((e) => e.type === "assistant.completed");
    assert.ok(calledTool, "expected the agent to call a tool");
    assert.ok(
      String(completed?.payload.text ?? "").includes("trevor-agent-ok"),
      String(completed?.payload.text ?? ""),
    );
  },
  200_000,
);
