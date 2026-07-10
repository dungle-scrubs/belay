import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { HighlightResult } from "./code-highlight";

// The hljs ENGINE half of the highlight boundary (Tier 5.2): everything that weighs - hljs core and
// all ~19 grammars - lives in this module, which only ever loads through the dynamic import in
// code-highlight.ts (triggered by the first closed fence that asks for highlighting). Never import
// this module statically from app code, or the whole engine rides the initial bundle again; go
// through the code-highlight facade instead.
//
// Future opt-in reuse (plan 36 boundary): this module is markdown-only today. Tool outputs, diff
// viewers, and terminal blocks are NOT wired in - before any of them reuses `highlightCode`, its
// renderer must (a) route Mermaid away first, (b) pass an explicit fenced language (never guess), and
// (c) keep its copy action sourced from the raw text, not the returned token markup.
//
// Explicit-language grammars only (plan 36): we register the languages Trevor transcripts actually
// carry and never auto-detect, so an unknown or bare fence stays plain and safe. Each grammar also
// registers the aliases it declares (`ts`, `sh`, `py`, `yml`, ...); a few extra aliases below cover
// spellings hljs doesn't ship. Runs once at module load, never on a render path (M2 REFACTOR).
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

hljs.registerAliases(["tsx"], { languageName: "typescript" });
hljs.registerAliases(["jsx"], { languageName: "javascript" });
hljs.registerAliases(["shell", "console"], { languageName: "bash" });
hljs.registerAliases(["jsonc"], { languageName: "json" });
hljs.registerAliases(["toml"], { languageName: "ini" });
hljs.registerAliases(["html"], { languageName: "xml" });

// Beyond these bounds a single block would make tokenization expensive enough to jank the virtualized
// transcript, so an oversized block stays plain <pre> text instead of freezing the list (M4).
const MAX_HIGHLIGHT_CHARS = 40_000;
const MAX_HIGHLIGHT_LINES = 2_000;
// A cheap bound on the module-level cache so a long session can't grow it without limit.
const MAX_CACHE_ENTRIES = 256;

// Highlighted markup keyed by `${grammar} ${code}`. A settled block is tokenized once and every
// later render (e.g. while a sibling block is still streaming) reuses the stored string (M4).
const cache = new Map<string, string>();

const NOT_HIGHLIGHTED: HighlightResult = { highlighted: false };

/**
 * The hljs grammar id (a registered name or alias) for an explicit fenced language, or `null` when
 * the block must render as plain code. Mermaid keeps its own language route (plan 19) and a
 * bare/unknown fence never guesses. hljs accepts aliases directly, so the normalized token is returned
 * as-is rather than collapsed to a canonical name.
 */
export function resolveHighlightLanguage(language: string): string | null {
  const normalized = language.trim().toLowerCase();
  if (normalized === "" || normalized === "mermaid") {
    return null;
  }
  return hljs.getLanguage(normalized) ? normalized : null;
}

/**
 * Highlights an explicit-language code block into hljs token spans, or reports `highlighted: false`
 * so the caller keeps the current plain <pre><code> rendering. Unknown languages, Mermaid, and
 * oversized blocks are never highlighted; results are cached by grammar + source.
 */
export function highlightCode(language: string, code: string): HighlightResult {
  const grammar = resolveHighlightLanguage(language);
  if (!grammar) {
    return NOT_HIGHLIGHTED;
  }
  if (code.length > MAX_HIGHLIGHT_CHARS || countLines(code) > MAX_HIGHLIGHT_LINES) {
    return NOT_HIGHLIGHTED;
  }

  const key = `${grammar} ${code}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return { highlighted: true, html: cached };
  }

  const { value } = hljs.highlight(code, { language: grammar, ignoreIllegals: true });
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, value);
  return { highlighted: true, html: value };
}

function countLines(text: string): number {
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      lines += 1;
    }
  }
  return lines;
}
