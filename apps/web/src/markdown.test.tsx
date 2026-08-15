import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, test, vi } from "vitest";
import { preloadHighlightEngine } from "./code-highlight";
import { Markdown } from "./markdown";

// The hljs engine lazy-loads behind the code-highlight facade (Tier 5.2); these tests assert
// loaded-engine rendering, so warm it up front. The plain-then-upgrade window is covered by
// markdown-highlight-upgrade.test.tsx, which needs its own (unwarmed) module registry.
beforeAll(() => preloadHighlightEngine());

afterEach(() => vi.restoreAllMocks());

test("wraps markdown tables in a horizontal scroll container", () => {
  const { container } = render(
    <Markdown
      text={[
        "| Severity | Finding | Fix |",
        "| --- | --- | --- |",
        "| HIGH | browser_tools_session.py and persistent_browser.py contain long filenames | Split responsibilities into smaller modules |",
      ].join("\n")}
    />,
  );

  const tableScroll = container.querySelector(".belay-md-table-scroll");
  assert.ok(tableScroll);
  assert.ok(tableScroll.querySelector("table"));
  assert.equal(screen.getByText("Severity").tagName, "TH");
});

test("copies fenced code block contents from the overlay button", () => {
  const writeText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

  render(<Markdown text={"```ts\nconst answer = 42;\nconsole.log(answer);\n```"} />);

  fireEvent.click(screen.getByLabelText("Copy code block"));

  assert.equal(writeText.mock.calls[0]?.[0], "const answer = 42;\nconsole.log(answer);");
});

test("routes explicit mermaid fenced blocks to the React diagram component", () => {
  const { container } = render(<Markdown text={"```mermaid\ngraph TD\n  A-->B\n```"} />);

  assert.ok(screen.getByTestId("mermaid-block"));
  assert.equal(screen.getByTestId("mermaid-source").textContent, "graph TD\n  A-->B");
  assert.equal(container.querySelector("pre code.language-mermaid"), null);
  assert.equal(screen.queryByLabelText("Copy code block"), null);
});

test("keeps ordinary fenced code blocks on the existing copyable code path", () => {
  const { container } = render(<Markdown text={"```mermaidish\ngraph TD\n  A-->B\n```"} />);

  assert.equal(screen.queryByTestId("mermaid-block"), null);
  assert.ok(container.querySelector("pre code.language-mermaidish"));
  assert.ok(screen.getByLabelText("Copy code block"));
});

test("normalizes mermaid language case and whitespace without false positives", () => {
  const routed = render(<Markdown text={"```  MERMAID   \nsequenceDiagram\n  A->>B: hi\n```"} />);
  assert.ok(screen.getByTestId("mermaid-block"));
  routed.unmount();

  const withInfo = render(<Markdown text={'```mermaid title="flow"\ngraph TD\n  A-->B\n```'} />);
  assert.ok(screen.getByTestId("mermaid-block"));
  withInfo.unmount();

  render(<Markdown text={"```not-mermaid\ngraph TD\n  A-->B\n```"} />);
  assert.equal(screen.queryByTestId("mermaid-block"), null);
});

test("keeps GFM tables, links, and ordinary code rendering across Mermaid splits", () => {
  const { container } = render(
    <Markdown
      text={[
        "See [docs](https://example.com).",
        "",
        "```mermaid",
        "graph TD",
        "  A-->B",
        "```",
        "",
        "| Name | Value |",
        "| --- | --- |",
        "| alpha | `code` |",
        "",
        "```sh",
        "echo done",
        "```",
      ].join("\n")}
    />,
  );

  assert.ok(screen.getByTestId("mermaid-block"));
  assert.equal(
    screen.getByRole("link", { name: "docs" }).getAttribute("href"),
    "https://example.com",
  );
  assert.ok(container.querySelector(".belay-md-table-scroll table"));
  const shCode = container.querySelector("pre code.language-sh");
  assert.ok(shCode);
  // The shell block is now syntax-highlighted, so its text is split across token spans; the block's
  // textContent still carries the source verbatim.
  assert.ok(shCode?.textContent?.includes("echo done"));
});

test("dedents a code block quoted from indented source, keeping relative indentation", () => {
  // Every line shares a 4-space indent; the nested arg is indented one level deeper. After dedent the
  // block starts flush-left but the nested arg keeps its extra indentation.
  const { container } = render(
    <Markdown text={"```python\n    run_config = Config(\n        threshold=5,\n    )\n```"} />,
  );
  const code = container.querySelector("pre code")?.textContent ?? "";
  assert.equal(
    code,
    "run_config = Config(\n    threshold=5,\n)\n",
    "common indent stripped, depth kept",
  );
});

test("dedent is a no-op for an already-flush block and for mixed tab/space indentation", () => {
  const flush = render(<Markdown text={"```\na()\n  b()\n```"} />);
  assert.equal(flush.container.querySelector("pre code")?.textContent, "a()\n  b()\n");

  // A space-indented line and a tab-indented line share no common whitespace prefix -> left untouched.
  const mixed = render(<Markdown text={"```\n    spaces()\n\ttab()\n```"} />);
  assert.equal(mixed.container.querySelector("pre code")?.textContent, "    spaces()\n\ttab()\n");
});

test("the dedented code is what gets copied", () => {
  const writeText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(<Markdown text={"```\n    x = 1\n        y = 2\n```"} />);
  fireEvent.click(screen.getByLabelText("Copy code block"));
  assert.equal(
    writeText.mock.calls[0]?.[0],
    "x = 1\n    y = 2",
    "copy matches the dedented display",
  );
});

test("highlights explicit closed-fence languages into hljs token spans", () => {
  const cases: readonly [string, string][] = [
    ["ts", "```ts\nconst answer = 42;\n```"],
    ["tsx", "```tsx\nconst App = () => <main />;\n```"],
    ["bash", "```bash\necho hi\n```"],
    ["json", '```json\n{ "answer": 42 }\n```'],
    ["diff", "```diff\n- old line\n+ new line\n```"],
  ];
  for (const [language, text] of cases) {
    const { container, unmount } = render(<Markdown text={text} />);
    const code = container.querySelector(`code.hljs.language-${language}`);
    assert.ok(code, `${language} block is highlighted with hljs + language class`);
    assert.ok(
      container.querySelector("code.hljs [class^='hljs-']"),
      `${language} block emits at least one token span`,
    );
    unmount();
  }
});

test("leaves unknown and no-language blocks as plain, unhighlighted code", () => {
  const unknown = render(<Markdown text={"```wat\nsome tokens here\n```"} />);
  assert.ok(unknown.container.querySelector("code.language-wat"));
  assert.equal(unknown.container.querySelector("code.hljs"), null);
  assert.equal(unknown.container.querySelector("[class^='hljs-']"), null);
  unknown.unmount();

  const bare = render(<Markdown text={"```\nplain text\n```"} />);
  assert.equal(bare.container.querySelector("code.hljs"), null);
  assert.equal(bare.container.querySelector("[class^='hljs-']"), null);
  assert.equal(bare.container.querySelector("pre code")?.textContent, "plain text\n");
});

test("never syntax-highlights a mermaid fence, even when diagram routing is off", () => {
  const { container } = render(
    <Markdown mermaid={false} text={"```mermaid\ngraph TD\n  A-->B\n```"} />,
  );
  assert.ok(container.querySelector("pre code.language-mermaid"));
  assert.equal(container.querySelector("code.hljs"), null);
  assert.equal(container.querySelector("[class^='hljs-']"), null);
  assert.equal(container.querySelector("pre code")?.textContent, "graph TD\n  A-->B\n");
});

test("copy stays the dedented raw source for a highlighted block", () => {
  const writeText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const { container } = render(
    <Markdown text={"```ts\n    const x = 1;\n    const y = 2;\n```"} />,
  );
  assert.ok(container.querySelector("code.hljs"), "block is highlighted");
  fireEvent.click(screen.getByLabelText("Copy code block"));
  assert.equal(
    writeText.mock.calls[0]?.[0],
    "const x = 1;\nconst y = 2;",
    "copy is the dedented source, not the token markup",
  );
});

test("escapes dangerous code content through highlighting and DOMPurify", () => {
  const { container } = render(
    <Markdown text={'```ts\nconst payload = "<img src=x onerror=alert(1)>";\n```'} />,
  );
  // hljs runs (token spans present), but the string content is inert text, not a live element.
  assert.ok(container.querySelector("code.hljs .hljs-string"));
  assert.equal(container.querySelector("img"), null);
  assert.equal(container.querySelector("script"), null);
  assert.ok(
    container.querySelector("pre code")?.textContent?.includes("<img src=x onerror=alert(1)>"),
    "the payload survives only as literal text",
  );
});

test("streaming rerenders converge to a parse of the complete final text", () => {
  // Simulates a streamed turn: each rerender is one delta of the same growing message. The parse is
  // deferred while streaming (useDeferredValue coalesces re-lex/re-sanitize passes), but the settled
  // message must always show the full text - including the syntax highlight that only becomes legal
  // once the closing fence arrives - never deferred/stale content.
  const chunks = [
    "Fib",
    "Fibonacci:\n\n```ts",
    "Fibonacci:\n\n```ts\nconst fib = (n: number): number =>",
    "Fibonacci:\n\n```ts\nconst fib = (n: number): number => (n < 2 ? n : fib(n - 1) + fib(n - 2));\n```\n\nDone.",
  ];
  const { container, rerender } = render(<Markdown text={chunks[0] ?? ""} />);
  for (const chunk of chunks.slice(1)) {
    rerender(<Markdown text={chunk} />);
  }
  const code = container.querySelector("code.hljs.language-ts");
  assert.ok(code, "closed fence from the final delta is highlighted");
  assert.ok(code?.textContent?.includes("fib(n - 1) + fib(n - 2)"), "full code body rendered");
  assert.ok(container.textContent?.includes("Done."), "text after the fence rendered");
});

test("defers highlighting for a still-streaming (unterminated) code fence", () => {
  const { container } = render(<Markdown text={"```ts\nconst answer = 42;\nconst pending ="} />);
  assert.equal(container.querySelector("code.hljs"), null, "no highlight while the fence is open");
  assert.equal(container.querySelector("[class^='hljs-']"), null);
  const code = container.querySelector("pre code.language-ts");
  assert.ok(code, "still renders as a plain ts code block");
  assert.ok(code?.textContent?.includes("const pending ="));
});
