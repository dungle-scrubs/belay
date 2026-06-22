import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";
import "./markdown.css";

// breaks: a lone newline becomes <br>, matching how chat answers are written
// (and the pre-wrap rendering this replaces); gfm enables tables, fenced code, etc.
marked.use({ gfm: true, breaks: true });

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
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false })), [text]);
  const className = muted ? "trevor-md trevor-md--muted" : "trevor-md";
  return (
    <div
      className={className}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized above.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
