import assert from "node:assert/strict";
import { test } from "vitest";
import { boundContent, classifyStatic, extractHtml } from "./extract";

/**
 * Extraction + classification coverage: title, article body, boilerplate drop, links, code blocks,
 * malformed HTML, the four static classifications (usable/thin/blocked/failed), and the text-length
 * cap with a visible truncation marker. Deterministic - no DOM, no network.
 */

test("extracts the title from <title>", () => {
  const { title } = extractHtml("<html><head><title>My Page</title></head><body>x</body></html>");
  assert.equal(title, "My Page");
});

test("extracts main article content and drops script/style/nav boilerplate", () => {
  const html = `
    <html><head><title>T</title><style>.a{color:red}</style></head>
    <body>
      <nav>Home About Contact</nav>
      <article><p>The real article body.</p></article>
      <script>console.log("noise")</script>
      <footer>copyright</footer>
    </body></html>`;

  const { content } = extractHtml(html);

  assert.ok(content.includes("The real article body."));
  assert.ok(!content.includes("console.log"), "script content dropped");
  assert.ok(!content.includes("color:red"), "style content dropped");
  assert.ok(!content.includes("Home About Contact"), "nav dropped");
  assert.ok(!content.includes("copyright"), "footer dropped");
});

test("keeps links as markdown and code as fenced blocks", () => {
  const html = `<html><body><article>
    See <a href="https://docs.example.com/x">the docs</a> for details.
    <pre>const x = 1;</pre>
    Inline <code>foo()</code> too.
  </article></body></html>`;

  const { content } = extractHtml(html);

  assert.ok(content.includes("[the docs](https://docs.example.com/x)"), "link kept as markdown");
  assert.ok(content.includes("```"), "code block fenced");
  assert.ok(content.includes("const x = 1;"), "code content kept");
  assert.ok(content.includes("`foo()`"), "inline code kept");
});

test("tolerates malformed HTML and still yields text", () => {
  const html = "<html><body><p>unclosed paragraph <b>bold <div>more text";
  const { content } = extractHtml(html);

  assert.ok(content.includes("unclosed paragraph"));
  assert.ok(content.includes("more text"));
});

test("decodes common HTML entities", () => {
  const { content } = extractHtml("<body><p>a &amp; b &lt; c &gt; d &#39;e&#39;</p></body>");
  assert.ok(content.includes("a & b < c > d 'e'"));
});

test("classifies a substantial article as usable", () => {
  const text = "This is a real article. ".repeat(40);
  const status = classifyStatic({
    httpStatus: 200,
    rawHtml: `<p>${text}</p>`,
    extractedText: text,
  });
  assert.equal(status, "usable");
});

test("classifies an empty body as thin", () => {
  const status = classifyStatic({
    httpStatus: 200,
    rawHtml: "<html><body></body></html>",
    extractedText: "",
  });
  assert.equal(status, "thin");
});

test("classifies a JS shell with little text as thin", () => {
  const rawHtml = `<html><body><div id="root"></div>${"<script>var a=1;</script>".repeat(20)}</body></html>`;
  const status = classifyStatic({ httpStatus: 200, rawHtml, extractedText: "Loading…" });
  assert.equal(status, "thin");
});

test("classifies a challenge/blocker page as blocked", () => {
  const rawHtml =
    "<html><body>Please enable JavaScript and cookies to continue. Checking your browser.</body></html>";
  const status = classifyStatic({
    httpStatus: 200,
    rawHtml,
    extractedText: "Checking your browser before accessing the site.",
  });
  assert.equal(status, "blocked");
});

test("classifies a 4xx/5xx or failed fetch as failed", () => {
  assert.equal(classifyStatic({ httpStatus: 404, rawHtml: "", extractedText: "" }), "failed");
  assert.equal(classifyStatic({ httpStatus: 503, rawHtml: "", extractedText: "" }), "failed");
  assert.equal(classifyStatic({ rawHtml: "", extractedText: "", fetchFailed: true }), "failed");
});

test("boundContent caps long content with a visible truncation marker", () => {
  const long = "x".repeat(500);
  const bounded = boundContent(long, 100);

  assert.equal(bounded.truncated, true);
  assert.ok(bounded.content.length < long.length);
  assert.ok(bounded.content.endsWith("…[truncated]"));
});

test("boundContent leaves short content untouched", () => {
  const bounded = boundContent("short", 100);
  assert.equal(bounded.truncated, false);
  assert.equal(bounded.content, "short");
});
