/**
 * D2 profiling gate (plan 58.6.3 M1) - THROWAWAY benchmark harness.
 *
 * Measures the per-streaming-frame cost of Trevor's whole-text markdown re-lex + re-sanitize path
 * (`apps/web/src/markdown.tsx:129` `markdownParts`) as a message streams in. Trevor re-lexes and
 * re-sanitizes the ENTIRE message on every settled delta frame (the `useDeferredValue` +
 * `useMemo(markdownParts(deferredText))` at markdown.tsx:179/186), which is O(len^2) over a turn.
 * This harness reproduces the hot inner cost (marked.lexer -> marked.parser -> DOMPurify.sanitize)
 * in isolation, driven over realistic streaming deltas at several final message lengths.
 *
 * It is a FAITHFUL REPLICA of the markdownParts core, not the real function (which is a non-exported
 * module-private in a React/DOM module). The replica uses the SAME marked config (gfm+breaks), the
 * SAME lexer/parser/DOMPurify call shape, and the SAME mermaid split. It deliberately omits the
 * syntax-highlight path: highlighting is defer-until-settle (only closed fences, engine lazy-loaded),
 * so it does NOT run on the streaming per-frame hot path this gate measures.
 *
 * Run: npx tsx .plans/58.6.3-audit-research-spikes/artifacts/markdown-relex-bench.ts
 *
 * NOTE ON NUMBERS: absolute ms in a headless jsdom + tsx process are NOT authoritative for the real
 * browser (no real layout/paint, jsdom DOMPurify differs from a browser's, JIT warmup differs). Treat
 * the SHAPE (super-linear growth of cumulative per-turn cost with length) and the RELATIVE per-frame
 * cost across 2/8/20/50KB as the signal. Authoritative absolute numbers need a real-browser profile
 * (Storybook story + Performance panel) on the dev machine - see the harness note in the findings.
 */

import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import { marked } from "marked";

// Mirror markdown.tsx:16 exactly.
marked.use({ gfm: true, breaks: true });

const { window } = new JSDOM("");
// biome-ignore lint: throwaway harness
const DOMPurify = createDOMPurify(window as unknown as Window & typeof globalThis);

function normalizeCodeLanguage(lang: string | undefined): string {
  return lang?.match(/\S+/)?.[0]?.toLowerCase() ?? "";
}

/**
 * Faithful replica of markdown.tsx:129 markdownParts core: lex the whole text, split mermaid fences
 * out, and DOMPurify-sanitize the marked.parser output of the remaining tokens. Returns nothing; the
 * benchmark only cares about the CPU spent, not the parts.
 */
function markdownPartsReplica(text: string, mermaid: boolean): void {
  const tokens = marked.lexer(text);
  let htmlTokens: marked.Token[] = [];
  const flushHtml = () => {
    if (htmlTokens.length > 0) {
      DOMPurify.sanitize(marked.parser([...htmlTokens], { async: false }));
    }
    htmlTokens = [];
  };
  for (const token of tokens) {
    if (mermaid && token.type === "code" && normalizeCodeLanguage(token.lang) === "mermaid") {
      flushHtml();
    } else {
      htmlTokens.push(token);
    }
  }
  flushHtml();
}

/**
 * Build a realistic ~N-byte assistant answer: prose paragraphs interleaved with a couple of fenced
 * code blocks, headings, lists, and a table - the mix an LLM coding answer actually streams.
 */
function buildMessage(targetBytes: number): string {
  const blocks: string[] = [
    "# Streaming markdown profiling\n",
    "Here is a walkthrough of the change, with the reasoning inline so you can follow each step.\n",
    "## Approach\n",
    "The projector folds the durable log incrementally. Each settled delta re-renders the body, and the parser re-lexes the *entire* message text again - which is the cost this benchmark isolates.\n",
    "- First we bound the input\n- Then we normalize the deltas\n- Finally we measure cumulative cost\n",
    "```ts\nfunction fold(events: readonly Event[]): Transcript {\n  const out: Row[] = [];\n  for (const e of events) out.push(project(e));\n  return out;\n}\n```\n",
    "A short note on **why** this matters: whole-text re-lex is `O(len^2)` across a turn.\n",
    "| length | frames | shape |\n| --- | --- | --- |\n| 2KB | ~20 | linear-ish |\n| 50KB | ~500 | quadratic |\n",
    "> Blockquote: the deferred value always converges to the latest text.\n",
    "```python\ndef fold(events):\n    out = []\n    for e in events:\n        out.append(project(e))\n    return out\n```\n",
    "Some more prose to pad the message toward the target length with ordinary sentences that a model would emit while explaining its work in a coding session with the user.\n",
  ];
  let text = "";
  let i = 0;
  while (Buffer.byteLength(text, "utf8") < targetBytes) {
    text += blocks[i % blocks.length];
    text += "\n";
    i += 1;
  }
  return text;
}

/**
 * Chunk the final text into realistic streaming deltas. Real provider deltas are small (a few tokens);
 * we use ~24-byte deltas, so a 20KB message is ~850 frames - matching the per-token re-render cadence
 * useDeferredValue coalesces. Returns the CUMULATIVE prefixes (what markdownParts actually sees each
 * settled frame).
 */
function streamingPrefixes(full: string, deltaBytes: number): string[] {
  const prefixes: string[] = [];
  for (let end = deltaBytes; end < full.length; end += deltaBytes) {
    prefixes.push(full.slice(0, end));
  }
  prefixes.push(full);
  return prefixes;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

interface Row {
  readonly kb: number;
  readonly bytes: number;
  readonly frames: number;
  readonly totalMs: number;
  readonly meanFrameMs: number;
  readonly medianFrameMs: number;
  readonly maxFrameMs: number;
  readonly finalFrameMs: number;
}

// useDeferredValue coalesces bursts, so the real app runs FEWER than one parse per delta. But the
// worst case (a slow reader, or a burst that settles between every delta) is one parse per prefix,
// and the per-turn TOTAL is what determines whether the main thread stays responsive. We report the
// full per-prefix sweep (upper bound) plus per-frame stats.
const DELTA_BYTES = 24;
const SIZES_KB = [2, 8, 20, 50];

function benchOne(kb: number): Row {
  const full = buildMessage(kb * 1024);
  const prefixes = streamingPrefixes(full, DELTA_BYTES);
  // Warm the JIT once on this text so we measure steady-state, not first-parse compile cost.
  markdownPartsReplica(full, true);

  const frameMs: number[] = [];
  const t0 = performance.now();
  for (const prefix of prefixes) {
    const s = performance.now();
    markdownPartsReplica(prefix, true);
    frameMs.push(performance.now() - s);
  }
  const totalMs = performance.now() - t0;
  return {
    kb,
    bytes: Buffer.byteLength(full, "utf8"),
    frames: prefixes.length,
    totalMs,
    meanFrameMs: totalMs / prefixes.length,
    medianFrameMs: median(frameMs),
    maxFrameMs: Math.max(...frameMs),
    finalFrameMs: frameMs[frameMs.length - 1]!,
  };
}

function main(): void {
  console.log(
    `\nD2 re-lex profiling (jsdom + tsx, ${DELTA_BYTES}B deltas, one parse per settled prefix = upper bound)\n`,
  );
  const rows: Row[] = [];
  for (const kb of SIZES_KB) {
    // Two passes; keep the second (steadier) to reduce cold-cache noise.
    benchOne(kb);
    rows.push(benchOne(kb));
  }
  const header = ["size", "bytes", "frames", "turn total ms", "mean/frame ms", "median/frame ms", "max/frame ms", "final/frame ms"];
  console.log(header.join("\t"));
  for (const r of rows) {
    console.log(
      [
        `${r.kb}KB`,
        r.bytes,
        r.frames,
        r.totalMs.toFixed(1),
        r.meanFrameMs.toFixed(3),
        r.medianFrameMs.toFixed(3),
        r.maxFrameMs.toFixed(3),
        r.finalFrameMs.toFixed(3),
      ].join("\t"),
    );
  }

  // Scaling check: per-turn total should grow SUPER-linearly with length if re-lex is the cost.
  console.log("\nScaling (per-turn total vs the 2KB baseline):");
  const base = rows[0]!;
  for (const r of rows) {
    const lenX = r.bytes / base.bytes;
    const costX = r.totalMs / base.totalMs;
    console.log(
      `  ${r.kb}KB: ${lenX.toFixed(1)}x length -> ${costX.toFixed(1)}x per-turn cost (super-linear if cost/length ratio > 1: ${(costX / lenX).toFixed(2)})`,
    );
  }
  console.log(
    "\nfinal-frame ms = cost of the SINGLE last parse of the complete message (the one-shot / settled cost).",
  );
}

main();
