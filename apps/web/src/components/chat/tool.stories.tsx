import type { Meta, StoryObj } from "@storybook/react-vite";
import { storyFrame } from "@/components/chat/story-frame";
import { ToolCall } from "./message";
import { type MultiEdit, MultiEditDiff } from "./multi-edit-diff";
import { ToolDiff } from "./tool-diff";
import { ToolOutput } from "./tool-output";
import { type WebSearchResultItem, WebSearchResults } from "./web-search";

// One story per host tool. read/bash/glob/grep/skill render as the generic ToolCall
// row; write/edit/multi_edit render diffs; web_search renders a result list. Every
// diff/result renderer takes a `border` prop, so those stories show both modes: flat
// (the tool row already collapses, so single-section tools default to flat) and
// bordered (the shared ToolSection box; multi_edit's per-file default).
const meta: Meta = {
  title: "Chat/Tools",
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj;

const Frame = storyFrame("w-[48rem]");

/** Stacks a tool's two renderings under small labels so border vs flat reads at a glance. */
const Variants = ({ children }: { children: React.ReactNode }) => (
  <Frame>
    <div className="flex flex-col gap-5">{children}</div>
  </Frame>
);
const Variant = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-label uppercase tracking-wider text-muted-foreground/50">{label}</span>
    {children}
  </div>
);

// In the live app a clicked file name opens the local editor (via the host). Storybook
// has no host, so this demo handler just reports the path that would be opened - enough
// to see the link styling (underline on hover) and the click wiring.
const openInEditor = (path: string) => window.alert(`open in editor: ${path}`);

const EDIT_OLD = `import { trim } from "./util";

export function greet(name) {
  const greeting = "hi " + name;
  return greeting;
}

export const DEFAULT_NAME = "world";`;

const EDIT_NEW = `import { trim } from "./util";

export function greet(name: string) {
  const greeting = \`hello, \${name}\`;
  return trim(greeting);
}

export const DEFAULT_NAME = "world";`;

const WRITTEN = `import { cn } from "@/lib/utils";

export function Spacer({ size = 4 }: { size?: number }) {
  return <div className={cn("w-full")} style={{ height: size * 4 }} />;
}`;

const SAME_FILE_EDITS: MultiEdit[] = [
  {
    path: "apps/web/src/greet.ts",
    old: `import { trim } from "./util";

export function greet(name) {
  const greeting = "hi " + name;
  return greeting;`,
    new: `import { trim } from "./util";

export function greet(name: string) {
  const greeting = "hi " + name;
  return greeting;`,
  },
  {
    path: "apps/web/src/greet.ts",
    old: `export function greet(name: string) {
  const greeting = "hi " + name;
  return greeting;
}`,
    new: `export function greet(name: string) {
  const greeting = \`hello, \${name}\`;
  return greeting;
}`,
  },
];

const MULTI_FILE_EDITS: MultiEdit[] = [
  {
    path: "apps/web/src/greet.ts",
    old: `  return greeting;
}

export const DEFAULT_NAME = "world";`,
    new: `  return greeting;
}

export const DEFAULT_NAME = "friend";`,
  },
  {
    path: "apps/web/src/router.ts",
    old: `const router = createRouter();

register("/old", handler);
router.start();`,
    new: `const router = createRouter();

register("/new", handler);
router.start();`,
  },
  {
    path: "apps/web/src/types.ts",
    old: `// Identifiers are opaque.
export type Id = number;
export type Name = string;`,
    new: `// Identifiers are opaque.
export type Id = string;
export type Name = string;`,
  },
];

const SEARCH_RESULTS: WebSearchResultItem[] = [
  {
    title: "Node.js - Previous Releases",
    url: "https://nodejs.org/en/about/previous-releases",
    snippet:
      'Node.js follows a release schedule with Long Term Support (LTS) lines. The current Active LTS is Node.js 22 "Jod", with maintenance through April 2027.',
    published: "3 days ago",
  },
  {
    title: "Node.js 22 enters Long Term Support",
    url: "https://nodejs.org/en/blog/release/v22.11.0",
    snippet:
      "Node.js 22.11.0 transitions the 22.x line to LTS. New projects should prefer the latest LTS for production workloads.",
    published: "2 weeks ago",
  },
  {
    title: "Releases - nodejs/node - GitHub",
    url: "https://github.com/nodejs/node/releases",
    snippet:
      "Tagged releases of the Node.js runtime, including security updates, Current builds, and every LTS line.",
    published: null,
  },
  {
    title: "How to choose a Node.js version for production",
    url: "https://blog.logrocket.com/how-to-choose-nodejs-version/",
    snippet:
      "A practical comparison of Current vs LTS releases and how the support windows affect upgrade planning.",
    published: "1 month ago",
  },
];

const QUERY = "node.js current lts version";

const BASH_OUTPUT = `$ tsgo --noEmit -p tsconfig.json
(no errors)`;

// A long listing: only the first few lines preview, the rest fold behind "+N more".
const FIND_OUTPUT = [
  "apps/agent-host/AGENTS.md",
  "apps/agent-host/package.json",
  "apps/agent-host/scripts/spike-a004-interrupt.ts",
  "apps/agent-host/scripts/verify-agent.mjs",
  "apps/agent-host/scripts/verify-turn.ts",
  "apps/agent-host/src/agent/history.ts",
  "apps/agent-host/src/agent/loop.ts",
  "apps/agent-host/src/agent/recovery.ts",
  "apps/agent-host/src/providers/codex.ts",
  "apps/agent-host/src/providers/system-prompt.ts",
  "apps/agent-host/src/tools/bash.ts",
  "apps/agent-host/src/tools/read.ts",
  "apps/agent-host/src/tools/web-search.ts",
].join("\n");

const GREP_OUTPUT = `src/app.tsx:173:  const transcript = useMemo(() => toTranscript(events), [events]);
src/session/use-session.ts:42:export function useSession(sessionId: string | null) {
src/transcript.ts:63:export function toTranscript(events: readonly SessionEvent[]): Message[] {`;

// Body-less tools: just the ToolCall row, no output to show, no border prop.
export const Read: Story = {
  render: () => (
    <Frame>
      <ToolCall
        name="read"
        args="apps/web/src/app.tsx"
        status="done"
        onOpenPath={() => openInEditor("apps/web/src/app.tsx")}
      />
    </Frame>
  ),
};

export const Glob: Story = {
  render: () => (
    <Frame>
      <ToolCall name="glob" args="apps/web/src/**/*.tsx" status="done" />
    </Frame>
  ),
};

export const Skill: Story = {
  render: () => (
    <Frame>
      <ToolCall name="skill" args="tdd" status="done" />
    </Frame>
  ),
};

// bash/grep render their text output via ToolOutput, flat by default; `border` boxes it.
export const Bash: Story = {
  render: () => (
    <Variants>
      <Variant label="flat (default)">
        <ToolOutput name="bash" args="pnpm --filter @trevor/web typecheck" output={BASH_OUTPUT} />
      </Variant>
      <Variant label="border">
        <ToolOutput
          name="bash"
          args="pnpm --filter @trevor/web typecheck"
          output={BASH_OUTPUT}
          border
        />
      </Variant>
    </Variants>
  ),
};

// Long output (a big `find` listing) previews its first few lines, with the rest
// hidden behind an ellipsis and a "+N more lines" indicator. The same cap applies to
// any text-output tool (grep, ...); a detailed full-output view is a separate control.
export const BashLongOutput: Story = {
  render: () => (
    <Variants>
      <Variant label="flat (default)">
        <ToolOutput name="bash" args="find apps/agent-host -type f | grep …" output={FIND_OUTPUT} />
      </Variant>
      <Variant label="border">
        <ToolOutput
          name="bash"
          args="find apps/agent-host -type f | grep …"
          output={FIND_OUTPUT}
          border
        />
      </Variant>
    </Variants>
  ),
};

export const Grep: Story = {
  render: () => (
    <Variants>
      <Variant label="flat (default)">
        <ToolOutput name="grep" args="useTetherSession" output={GREP_OUTPUT} />
      </Variant>
      <Variant label="border">
        <ToolOutput name="grep" args="useTetherSession" output={GREP_OUTPUT} border />
      </Variant>
    </Variants>
  ),
};

// write: a brand-new file (all additions). Flat by default; `border` boxes it.
export const Write: Story = {
  render: () => (
    <Variants>
      <Variant label="flat (default)">
        <ToolDiff
          tool="write"
          path="apps/web/src/components/spacer.tsx"
          newText={WRITTEN}
          onOpenPath={() => openInEditor("apps/web/src/components/spacer.tsx")}
        />
      </Variant>
      <Variant label="border">
        <ToolDiff
          tool="write"
          path="apps/web/src/components/spacer.tsx"
          newText={WRITTEN}
          border
          onOpenPath={() => openInEditor("apps/web/src/components/spacer.tsx")}
        />
      </Variant>
    </Variants>
  ),
};

// edit: in-place replacement, up to 3 lines of subdued context. Flat by default.
export const Edit: Story = {
  render: () => (
    <Variants>
      <Variant label="flat (default)">
        <ToolDiff
          tool="edit"
          path="apps/web/src/greet.ts"
          oldText={EDIT_OLD}
          newText={EDIT_NEW}
          onOpenPath={() => openInEditor("apps/web/src/greet.ts")}
        />
      </Variant>
      <Variant label="border">
        <ToolDiff
          tool="edit"
          path="apps/web/src/greet.ts"
          oldText={EDIT_OLD}
          newText={EDIT_NEW}
          border
          onOpenPath={() => openInEditor("apps/web/src/greet.ts")}
        />
      </Variant>
    </Variants>
  ),
};

// multi_edit, several edits to one file (one atomic operation). Bordered per file by
// default; `border={false}` flattens to a name + stat header over each file's diffs.
export const MultiEditSameFile: Story = {
  render: () => (
    <Variants>
      <Variant label="border (default)">
        <MultiEditDiff edits={SAME_FILE_EDITS} onOpenPath={openInEditor} />
      </Variant>
      <Variant label="flat">
        <MultiEditDiff edits={SAME_FILE_EDITS} border={false} onOpenPath={openInEditor} />
      </Variant>
    </Variants>
  ),
};

// multi_edit across several files, each with its own context.
export const MultiEditMultiFile: Story = {
  render: () => (
    <Variants>
      <Variant label="border (default)">
        <MultiEditDiff edits={MULTI_FILE_EDITS} onOpenPath={openInEditor} />
      </Variant>
      <Variant label="flat">
        <MultiEditDiff edits={MULTI_FILE_EDITS} border={false} onOpenPath={openInEditor} />
      </Variant>
    </Variants>
  ),
};

// web_search renders the tool's normalized output as a result list: each title is a
// link, with its source URL, snippet, and recency, under a provider · count · freshness
// meta line. Flat by default; `border` wraps it in the shared ToolSection box.
export const WebSearch: Story = {
  render: () => (
    <Variants>
      <Variant label="flat (default)">
        <WebSearchResults query={QUERY} provider="brave" results={SEARCH_RESULTS} />
      </Variant>
      <Variant label="border">
        <WebSearchResults query={QUERY} provider="brave" results={SEARCH_RESULTS} border />
      </Variant>
    </Variants>
  ),
};

// A recency filter shows as "past <window>" in the meta line.
export const WebSearchFreshness: Story = {
  render: () => (
    <Frame>
      <WebSearchResults
        query="claude opus pricing"
        provider="brave"
        freshness="week"
        results={SEARCH_RESULTS.slice(0, 2)}
      />
    </Frame>
  ),
};

// Brave was unconfigured or failed, so Serper served the results (the fallback path).
export const WebSearchSerperFallback: Story = {
  render: () => (
    <Frame>
      <WebSearchResults query={QUERY} provider="serper" results={SEARCH_RESULTS.slice(0, 3)} />
    </Frame>
  ),
};

export const WebSearchNoResults: Story = {
  render: () => (
    <Frame>
      <WebSearchResults query="qwpoizx nonexistent term zzz" provider="brave" results={[]} />
    </Frame>
  ),
};

export const WebSearchRunning: Story = {
  render: () => (
    <Frame>
      <WebSearchResults query={QUERY} status="running" />
    </Frame>
  ),
};

// The host renders typed errors (e.g. missing credentials) into this message.
export const WebSearchError: Story = {
  render: () => (
    <Frame>
      <WebSearchResults query={QUERY} error="Missing BRAVE_API_KEY or SERPER_API_KEY" />
    </Frame>
  ),
};

// Compact view: every result-bearing tool call collapsed to its one-line header -
// the shape a future global "compact" setting produces by passing defaultOpen={false}.
// Each row is still a live trigger: click to expand it. Body-less rows (read) are
// already one line.
export const CompactCollapsed: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-col gap-2">
        <WebSearchResults
          query={QUERY}
          provider="brave"
          results={SEARCH_RESULTS}
          defaultOpen={false}
        />
        <ToolDiff
          tool="edit"
          path="apps/web/src/greet.ts"
          oldText={EDIT_OLD}
          newText={EDIT_NEW}
          defaultOpen={false}
        />
        <MultiEditDiff edits={MULTI_FILE_EDITS} defaultOpen={false} />
        <ToolCall name="read" args="apps/web/src/app.tsx" />
      </div>
    </Frame>
  ),
};
