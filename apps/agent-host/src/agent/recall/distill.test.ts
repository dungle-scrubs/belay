import assert from "node:assert/strict";
import { Effect, Stream } from "effect";
import { test } from "vitest";
import type { Provider, ProviderEvent } from "../../providers";
import { buildDistillPrompt, distillRecall, parseCitations } from "./distill";
import type { RecallNeighborhood, RecallRecord, RecallSessionRef } from "./types";

/**
 * D-044 M3: the isolated, tool-less recall reasoning pass. A fake provider stands in for the
 * model; these pin that the pass is tool-less, reads only the supplied neighborhoods, caps its
 * answer, and parses inline `[Sn]` citations - so the main turn gets findings, not raw recall.
 */

function fakeProvider(opts: {
  text?: string;
  capture?: (tools: number, reasoning: string | undefined) => void;
}): Provider {
  const reasoningLevels = ["off", "low"];
  return {
    id: "fake",
    label: "Fake",
    model: "fake-1",
    reasoningLevels,
    defaultReasoning: "off",
    kind: "cloud",
    describe: () => ({
      label: "Fake",
      model: "fake-1",
      reasoningLevels,
      defaultReasoning: "off",
      kind: "cloud",
    }),
    readiness: () => Effect.succeed({ ready: true, warm: true }),
    capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 0 }),
    warm: () => Effect.void,
    stream: (_messages, tools, reasoning) => {
      opts.capture?.(tools.length, reasoning);
      return Stream.fromIterable<ProviderEvent>([{ type: "text", text: opts.text ?? "" }]);
    },
  };
}

const REF: RecallSessionRef = {
  sessionId: "sib",
  label: "old session",
  project: "p",
  origin: "sibling-session",
};

function rec(seq: number): RecallRecord {
  return {
    id: `sib#${seq}`,
    session: REF,
    seq,
    range: { fromSeq: seq, toSeq: seq },
    kind: "user",
    runId: null,
    tool: null,
    foldId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    text: `content ${seq}`,
  };
}

const NB: RecallNeighborhood = {
  anchor: { record: rec(5), score: 2, excerpt: "content 5" },
  records: [rec(4), rec(5), rec(6)],
};

test("buildDistillPrompt numbers sources and pins the model to them", () => {
  const [message] = buildDistillPrompt({ query: "what did we decide", neighborhoods: [NB] });
  assert.ok(message);
  assert.match(message.content, /\[S1\] old session · sibling-session · turns 5-5/);
  assert.match(message.content, /Use ONLY the numbered sources/);
  assert.match(message.content, /what did we decide/);
  assert.match(message.content, /content 4/);
});

test("distillRecall is tool-less, with reasoning forced to the cheapest level", async () => {
  let tools = -1;
  let reasoning: string | undefined = "unset";
  await Effect.runPromise(
    distillRecall(
      fakeProvider({
        text: "answer [S1]",
        capture: (t, r) => {
          tools = t;
          reasoning = r;
        },
      }),
      { query: "q", neighborhoods: [NB] },
    ),
  );
  assert.equal(tools, 0, "the reasoning pass is offered no tools (read-only by construction)");
  assert.equal(reasoning, "off", "reasoning forced to the cheapest level");
});

test("distillRecall parses inline [Sn] citations from the answer", async () => {
  const out = await Effect.runPromise(
    distillRecall(
      fakeProvider({ text: "We chose BM25 [S2] over embeddings [S1], confirmed in [S2]." }),
      {
        query: "q",
        neighborhoods: [NB, NB, NB],
      },
    ),
  );
  assert.deepEqual(out.citedSources, [2, 1], "distinct source indexes in first-seen order");
  assert.match(out.text, /BM25/);
});

test("distillRecall caps a long answer to the findings backstop", async () => {
  const out = await Effect.runPromise(
    distillRecall(fakeProvider({ text: "x".repeat(9_000) }), { query: "q", neighborhoods: [NB] }),
  );
  assert.equal(out.text.length, 2_000, "capped to the ~600-token (~2k-char) findings backstop");
});

test("parseCitations ignores noise and dedupes", () => {
  assert.deepEqual(parseCitations("see [S1], also [S1] and [S10] but not [Sx]"), [1, 10]);
  assert.deepEqual(parseCitations("no citations here"), []);
});
