import type { Meta, StoryObj } from "@storybook/react-vite";
import { MarkdownBody } from "@/components/chat/markdown-body";
import { storyFrame } from "@/components/chat/story-frame";

/**
 * Syntax highlighting for transcript code blocks (plan 36). Explicit fenced languages render as hljs
 * token spans colored from the SMUI palette (so they flip with light/dark); unknown, bare, and
 * still-streaming fences stay plain and safe; Mermaid keeps its own diagram route. These stories cover
 * the language matrix plus the long/wide/narrow/mixed/dark/high-contrast and streaming states that the
 * automated visual-regression lane (plan 09.2) baselines.
 */
const meta: Meta<typeof MarkdownBody> = {
  title: "Chat/MarkdownCode",
  component: MarkdownBody,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof MarkdownBody>;

const Frame = storyFrame("w-[40rem]");

const TYPESCRIPT = `A typed helper:

\`\`\`ts
type Route = { readonly path: string; readonly title: string };

export function titleFor(routes: readonly Route[], path: string): string {
  const match = routes.find((route) => route.path === path);
  return match?.title ?? "Untitled"; // fall back when the path is unknown
}
\`\`\``;

const TSX = `A small component:

\`\`\`tsx
export function Badge({ label, tone }: { label: string; tone: "ok" | "warn" }) {
  return <span className={\`badge badge--\${tone}\`}>{label}</span>;
}
\`\`\``;

const SHELL = `Run the checks:

\`\`\`bash
#!/usr/bin/env bash
set -euo pipefail
pnpm lint && pnpm typecheck
echo "all green" | tee results.log
\`\`\``;

const JSON_BLOCK = `The session record:

\`\`\`json
{
  "id": "sess_42",
  "model": "qwen3.6-27b-mlx",
  "streaming": true,
  "tokens": { "in": 3300, "out": 812 }
}
\`\`\``;

const DIFF = `The patch:

\`\`\`diff
@@ -1,4 +1,4 @@
 export function render(text: string) {
-  return escape(text);
+  return highlight(text) ?? escape(text);
 }
\`\`\``;

const PYTHON = `A quick script:

\`\`\`python
def fib(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):  # iterate n times
        a, b = b, a + b
    return a
\`\`\``;

const UNKNOWN = `An unrecognized language stays plain:

\`\`\`brainfuck
++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]
\`\`\``;

const NO_LANGUAGE = `A bare fence stays plain:

\`\`\`
just some
  indented output
that is not a known language
\`\`\``;

const MIXED = `Here is the plan:

1. Normalize the fenced **language** token.
2. Route \`mermaid\` to its diagram component.
3. Highlight everything else.

\`\`\`ts
const routes = ["mermaid", "highlight", "plain"] as const;
\`\`\`

See [the renderer](https://example.com) and the \`markdown.css\` tokens.`;

const FULL_MARKDOWN = `# Evidence

Trevor already has the core job registry, and this paragraph checks the default prose color, line height, wrapping, **strong text**, *emphasis*, \`inline code\`, and [links](https://example.com).

## Existing behavior

- Host tracks promoted and direct background jobs in memory.
- On exit it marks the status and re-announces the job.
- Snapshots include terminal jobs.

### Plan scope

1. Add host-owned terminal job cleanup primitives.
2. Expose cleanup through command surfaces.
3. Add a direct UI affordance.

#### Nested list alignment

- Process registry
  - \`dismiss(id)\` removes exited or killed jobs.
  - \`clearCompleted()\` keeps running jobs.
- Transcript UI
  1. Finished rows show dismiss.
  2. Running rows keep stop.

##### Blockquote

> Manual dismiss remains the deterministic cleanup path, while successful jobs can prune themselves after a short grace period.

###### Table

| Surface | Behavior | Status |
| --- | --- | --- |
| Host | Tracks jobs | Ready |
| Commands | Dismisses terminal jobs | Ready |
| UI | Shows the affordance | Ready |

---

\`\`\`ts
type CleanupAction = "dismiss" | "clear_completed";

export function canDismiss(status: "running" | "exited" | "killed") {
  return status !== "running";
}
\`\`\`

Closing paragraph after the code block, so the full vertical rhythm can be checked in one scan.`;

const LONG = `A long block scrolls vertically inside the code chrome:

\`\`\`ts
${Array.from({ length: 40 }, (_, i) => `const line${i} = compute(${i}, previous(${i - 1}));`).join("\n")}
\`\`\``;

const WIDE = `A wide block scrolls horizontally without colliding with the copy button:

\`\`\`ts
const message = "a single very long line of source that extends well past the width of the code block so the horizontal scrollbar has to appear and the copy button must not overlap the text";
\`\`\``;

const STREAMING = `A still-streaming block has no closing fence yet, so highlighting is deferred until it settles:

\`\`\`ts
export function stream(chunk: string) {
  buffer += chunk;
  const pending =`;

export const TypeScript: Story = {
  render: () => (
    <Frame>
      <MarkdownBody text={TYPESCRIPT} />
    </Frame>
  ),
};

export const FullMarkdown: Story = {
  render: () => (
    <Frame>
      <MarkdownBody text={FULL_MARKDOWN} />
    </Frame>
  ),
};

export const Tsx: Story = {
  render: () => (
    <Frame>
      <MarkdownBody text={TSX} />
    </Frame>
  ),
};

export const Shell: Story = {
  render: () => (
    <Frame>
      <MarkdownBody text={SHELL} />
    </Frame>
  ),
};

export const Json: Story = {
  render: () => (
    <Frame>
      <MarkdownBody text={JSON_BLOCK} />
    </Frame>
  ),
};

export const Diff: Story = {
  render: () => (
    <Frame>
      <MarkdownBody text={DIFF} />
    </Frame>
  ),
};

export const Python: Story = {
  render: () => (
    <Frame>
      <MarkdownBody text={PYTHON} />
    </Frame>
  ),
};

export const UnknownLanguage: Story = {
  render: () => (
    <Frame>
      <MarkdownBody text={UNKNOWN} />
    </Frame>
  ),
};

export const NoLanguage: Story = {
  render: () => (
    <Frame>
      <MarkdownBody text={NO_LANGUAGE} />
    </Frame>
  ),
};

export const MixedProseAndCode: Story = {
  render: () => (
    <Frame>
      <MarkdownBody text={MIXED} />
    </Frame>
  ),
};

export const LongCode: Story = {
  render: () => (
    <Frame>
      <MarkdownBody text={LONG} />
    </Frame>
  ),
};

export const WideCode: Story = {
  render: () => (
    <Frame>
      <MarkdownBody text={WIDE} />
    </Frame>
  ),
};

export const StreamingDeferred: Story = {
  render: () => (
    <Frame>
      <MarkdownBody text={STREAMING} />
    </Frame>
  ),
};

// A narrow transcript column: the wide block must still scroll horizontally without breaking layout.
export const NarrowViewport: Story = {
  render: () => (
    <div className="w-[20rem] max-w-full">
      <MarkdownBody text={WIDE} />
    </div>
  ),
};

export const Dark: Story = {
  render: () => (
    <div className="dark bg-background p-4 text-foreground">
      <Frame>
        <MarkdownBody text={TYPESCRIPT} />
      </Frame>
    </div>
  ),
};

export const HighContrast: Story = {
  render: () => (
    <div className="bg-background p-4 text-foreground contrast-more:border contrast-more:border-foreground">
      <Frame>
        <MarkdownBody text={DIFF} />
      </Frame>
    </div>
  ),
};

// The reasoning trace: same highlighting, dimmed via the muted variant.
export const Muted: Story = {
  render: () => (
    <Frame>
      <MarkdownBody muted text={TYPESCRIPT} />
    </Frame>
  ),
};
