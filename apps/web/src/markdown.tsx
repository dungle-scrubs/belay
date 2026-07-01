import DOMPurify from "dompurify";
import { marked, type Tokens } from "marked";
import { useEffect, useMemo, useRef } from "react";
import { MermaidBlock } from "./mermaid-block";
import "./markdown.css";

// breaks: a lone newline becomes <br>, matching how chat answers are written
// (and the pre-wrap rendering this replaces); gfm enables tables, fenced code, etc.
marked.use({ gfm: true, breaks: true });

const renderer = new marked.Renderer();
const renderTable = renderer.table.bind(renderer);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeCodeText(text: string): string {
  return `${text.replace(/\n$/, "")}\n`;
}

function normalizeCodeLanguage(lang: string | undefined): string {
  return lang?.match(/\S+/)?.[0]?.toLowerCase() ?? "";
}

/**
 * Strips the COMMON leading whitespace shared by every non-blank line of a code block, so a snippet
 * the model quoted from indented source (a method body, a nested config) renders flush-left instead of
 * pushed in - while keeping each line's indentation RELATIVE to the others. The common indent is the
 * longest shared whitespace prefix (so mixed tabs/spaces that don't agree dedent to nothing, never
 * corrupting alignment). Blank lines don't count toward the common prefix and are left as-is.
 */
function dedentCode(text: string): string {
  const lines = text.split("\n");
  let common: string | null = null;
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    const indent = line.match(/^[ \t]*/)?.[0] ?? "";
    if (common === null) {
      common = indent;
    } else {
      let i = 0;
      const max = Math.min(common.length, indent.length);
      while (i < max && common[i] === indent[i]) {
        i += 1;
      }
      common = common.slice(0, i);
    }
    if (common === "") {
      return text;
    }
  }
  if (!common) {
    return text;
  }
  const prefix = common;
  return lines
    .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
    .join("\n");
}

renderer.table = (token: Tokens.Table) =>
  `<div class="trevor-md-table-scroll">${renderTable(token)}</div>`;

// The lucide `Copy` glyph, inlined so the code-block copy button (rendered as a sanitized HTML string,
// not React) uses the same icon set as the rest of the app. DOMPurify keeps svg/rect/path by default.
const COPY_ICON =
  '<svg class="trevor-md-code-copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

renderer.code = ({ text, lang, escaped }: Tokens.Code) => {
  const language = lang?.match(/\S+/)?.[0] ?? "";
  const className = language ? ` class="language-${escapeHtml(language)}"` : "";
  // Dedent so a block quoted from indented source renders flush-left; the copy matches what's shown.
  const code = dedentCode(text);
  const displayText = normalizeCodeText(code);
  const codeHtml = escaped ? displayText : escapeHtml(displayText);
  const copyText = encodeURIComponent(code);

  return `<div class="trevor-md-codeblock"><button type="button" class="trevor-md-code-copy" data-trevor-copy-code="${copyText}" aria-label="Copy code block" title="Copy code block">${COPY_ICON}</button><pre><code${className}>${codeHtml}</code></pre></div>\n`;
};

type MarkdownPart =
  | { readonly kind: "html"; readonly html: string }
  | { readonly kind: "mermaid"; readonly source: string };

function sanitizedHtmlFromTokens(tokens: readonly Tokens.Generic[]): string {
  if (tokens.length === 0) {
    return "";
  }
  return DOMPurify.sanitize(marked.parser([...tokens], { async: false, renderer }));
}

function markdownParts(text: string, mermaid: boolean): readonly MarkdownPart[] {
  const tokens = marked.lexer(text);
  const parts: MarkdownPart[] = [];
  let htmlTokens: Tokens.Generic[] = [];

  const flushHtml = () => {
    const html = sanitizedHtmlFromTokens(htmlTokens);
    if (html.length > 0) {
      parts.push({ kind: "html", html });
    }
    htmlTokens = [];
  };

  for (const token of tokens) {
    if (mermaid && token.type === "code" && normalizeCodeLanguage(token.lang) === "mermaid") {
      flushHtml();
      parts.push({ kind: "mermaid", source: dedentCode(token.text) });
    } else {
      htmlTokens.push(token);
    }
  }
  flushHtml();

  return parts;
}

/**
 * Renders model-authored markdown as HTML. The model's output is untrusted, so
 * marked's HTML is run through DOMPurify before it reaches the DOM - never render
 * marked output without sanitizing it.
 */
export function Markdown({
  text,
  muted = false,
  mermaid = true,
}: {
  readonly text: string;
  /** Dim + italicize for the reasoning trace, keeping markdown structure. */
  readonly muted?: boolean;
  /** Render explicit fenced Mermaid diagrams as transcript diagrams instead of plain code. */
  readonly mermaid?: boolean;
}) {
  const parts = useMemo(() => markdownParts(text, mermaid), [mermaid, text]);
  const className = muted ? "trevor-md trevor-md--muted" : "trevor-md";
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const copyCodeBlock = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest<HTMLButtonElement>("[data-trevor-copy-code]");
      if (!button || !container.contains(button)) {
        return;
      }
      const encoded = button.dataset.trevorCopyCode;
      if (!encoded) {
        return;
      }
      void navigator.clipboard?.writeText(decodeURIComponent(encoded));
    };
    container.addEventListener("click", copyCodeBlock);
    return () => container.removeEventListener("click", copyCodeBlock);
  }, []);

  return (
    <div ref={containerRef} className={className}>
      {parts.map((part, index) =>
        part.kind === "mermaid" ? (
          <MermaidBlock
            // biome-ignore lint/suspicious/noArrayIndexKey: markdown token order is stable for a given text render.
            key={index}
            source={part.source}
          />
        ) : (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: markdown token order is stable for a given text render.
            key={index}
            className="trevor-md__html"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized before insertion.
            dangerouslySetInnerHTML={{ __html: part.html }}
          />
        ),
      )}
    </div>
  );
}
