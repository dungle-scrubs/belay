import { testIdentity } from "@belay/session/testing";
import { recordingTransport } from "@belay/test-kit";
import type { DelegationContext } from "@host/agent/delegate";
import type { ProviderEvent } from "@host/providers";
import { type LeafHostContext, runAgentLeaf } from "@host/workflow/leaf-host";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vitest";
import { fakeProvider } from "./support/fake-provider";

/**
 * Integration coverage for the workflow `agent()` leaf (plan 21 M2): it drives the REAL publishTurn
 * against a recording transport + fake provider, so a single-turn leaf returns its child's text, a
 * schema request yields a validated object, the child session sees ONLY the seeded task (isolation),
 * and the parent gets a done fold-back link.
 */

/** A provider that answers with one text step (no tool call), ending the turn immediately. */
function answering(text: string) {
  return fakeProvider({
    step: (): readonly ProviderEvent[] => [
      { type: "text", text },
      { type: "usage", usage: { input: 10, output: 5, contextWindow: 1000, genMs: 1 } },
    ],
  });
}

function makeHost() {
  const recording = recordingTransport();
  let runN = 0;
  const ctx: DelegationContext = {
    transport: recording.transport,
    parentSessionId: "parent",
    producerId: "host-prod",
    mintChildSessionId: () => "child",
  };
  const host: LeafHostContext = {
    ctx,
    identity: testIdentity("leaf-reader"),
    mintRunId: () => `run-${runN++}`,
  };
  return { recording, host };
}

const baseRequest = {
  prompt: "do the thing",
  childSessionId: "child",
  childRunId: "cr1",
  parentRunId: "pr1",
} as const;

describe("runAgentLeaf", () => {
  test("a single-turn leaf spawns an isolated child and returns its text", async () => {
    const { recording, host } = makeHost();
    const result = await Effect.runPromise(
      runAgentLeaf(host, { ...baseRequest, provider: answering("hello world") }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("hello world");
      expect(result.childSessionId).toBe("child");
    }

    // Isolation: the child's only user message is the seeded task - no parent transcript leaked.
    const userMessages = recording
      .publishedBy("child")
      .filter((event) => event.type === "user.message");
    expect(userMessages).toHaveLength(1);
    expect((userMessages[0]?.payload as { text: string }).text).toBe("do the thing");
  });

  test("opts.schema returns a validated object", async () => {
    const { host } = makeHost();
    const result = await Effect.runPromise(
      runAgentLeaf(host, {
        ...baseRequest,
        provider: answering('{"n":42}'),
        schema: Schema.Struct({ n: Schema.Number }),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ n: 42 });
    }
  });

  test("folds a terminal done link back onto the parent session", async () => {
    const { recording, host } = makeHost();
    await Effect.runPromise(runAgentLeaf(host, { ...baseRequest, provider: answering("ok") }));
    const links = recording.publishedBy("parent").filter((event) => event.type === "delegated.to");
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect((links.at(-1)?.payload as { status: string }).status).toBe("done");
  });
});
