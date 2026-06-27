import DOMPurify from "dompurify";
import { marked, type Tokens } from "marked";
import { useEffect, useMemo, useRef } from "react";
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

renderer.table = (token: Tokens.Table) =>
  `<div class="trevor-md-table-scroll">${renderTable(token)}</div>`;

renderer.code = ({ text, lang, escaped }: Tokens.Code) => {
  const language = lang?.match(/\S*/)?.[0] ?? "";
  const className = language ? ` class="language-${escapeHtml(language)}"` : "";
  const displayText = normalizeCodeText(text);
  const codeHtml = escaped ? displayText : escapeHtml(displayText);
  const copyText = encodeURIComponent(text);

  return `<div class="trevor-md-codeblock"><button type="button" class="trevor-md-code-copy" data-trevor-copy-code="${copyText}" aria-label="Copy code block" title="Copy code block"><span class="trevor-md-code-copy-icon" aria-hidden="true"></span></button><pre><code${className}>${codeHtml}</code></pre></div>\n`;
};

/**
 * Renders model-authored markdown as HTML. The model's output is untrusted, so
 * marked's HTML is run through DOMPurify before it reaches the DOM - never render
 * marked output without sanitizing it.
 */
export function Markdown({
  text,
  muted = false,
}: {
  readonly text: string;
  /** Dim + italicize for the reasoning trace, keeping markdown structure. */
  readonly muted?: boolean;
}) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false, renderer })),
    [text],
  );
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
    <div
      ref={containerRef}
      className={className}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized above.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
