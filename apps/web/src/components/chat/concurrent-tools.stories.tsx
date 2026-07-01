import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { storyFrame } from "@/components/chat/story-frame";
import { type ConcurrentTool, ConcurrentTools } from "./concurrent-tools";
import { ToolCall } from "./message";

// Read-only tools (read/glob/grep/web_search) the host fans out in parallel. Each
// renders as one tight line with a leading spinner while it runs; the spinner clears
// when that call settles, so the batch is "done" once every spinner is gone. Stories
// walk the lifecycle: all running -> settling out of order -> all done, plus an error
// row and a looping live demo.
const meta: Meta = {
  title: "Chat/Concurrent Tools",
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj;

const Frame = storyFrame("w-[48rem]");

// In the live app a clicked read path opens the local editor (via the host). Storybook
// has no host, so this just reports the path - enough to see the link + click wiring.
const openInEditor = (path: string) => window.alert(`open in editor: ${path}`);

// A realistic concurrent batch: the model fired four file reads, a grep, and a web
// search at once. `onOpenPath` is wired on the read rows (clickable args).
const BATCH: readonly Omit<ConcurrentTool, "status">[] = [
  {
    id: "r1",
    name: "read",
    args: "apps/web/src/app.tsx",
    onOpenPath: () => openInEditor("apps/web/src/app.tsx"),
  },
  {
    id: "r2",
    name: "read",
    args: "apps/web/src/transcript.ts",
    onOpenPath: () => openInEditor("apps/web/src/transcript.ts"),
  },
  { id: "g1", name: "grep", args: "toTranscript" },
  { id: "gl", name: "glob", args: "apps/web/src/**/*.tsx" },
  {
    id: "r3",
    name: "read",
    args: "packages/session/src/protocol.ts",
    onOpenPath: () => openInEditor("packages/session/src/protocol.ts"),
  },
  { id: "ws", name: "web_search", args: "node.js current lts version" },
];

const withStatus = (
  statuses: Record<string, ConcurrentTool["status"]>,
  fallback: ConcurrentTool["status"],
): ConcurrentTool[] => BATCH.map((t) => ({ ...t, status: statuses[t.id] ?? fallback }));

// Every call still in flight: six spinners, the start of a parallel burst.
export const AllRunning: Story = {
  render: () => (
    <Frame>
      <ConcurrentTools tools={withStatus({}, "running")} />
    </Frame>
  ),
};

// The interesting state: some calls have settled (spinner cleared, row dimmed) while
// others spin. Reads finished fast; grep + web_search are still going.
export const Settling: Story = {
  render: () => (
    <Frame>
      <ConcurrentTools
        tools={withStatus({ r1: "done", r2: "done", r3: "done", gl: "done" }, "running")}
      />
    </Frame>
  ),
};

// Batch complete: no spinners, every row settled to its frost "done" tint.
export const AllDone: Story = {
  render: () => (
    <Frame>
      <ConcurrentTools tools={withStatus({}, "done")} />
    </Frame>
  ),
};

// One call failed (red wrench) while the rest succeeded; the batch is still finished.
export const WithError: Story = {
  render: () => (
    <Frame>
      <ConcurrentTools tools={withStatus({ ws: "error" }, "done")} />
    </Frame>
  ),
};

// Plays the batch finishing one row at a time, then loops, so the spinner-clears-on-
// finish behavior reads at a glance.
function LiveDemo() {
  const [doneCount, setDoneCount] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setDoneCount((n) => (n >= BATCH.length ? 0 : n + 1));
    }, 850);
    return () => clearInterval(id);
  }, []);

  const tools: ConcurrentTool[] = BATCH.map((t, i) => ({
    ...t,
    status: i < doneCount ? "done" : "running",
  }));

  return (
    <Frame>
      <ConcurrentTools tools={tools} />
    </Frame>
  );
}

export const Live: Story = {
  render: () => <LiveDemo />,
};

// Proves the batch sits flush in a real transcript: a collapsible tool (leading
// chevron), the running batch (leading spinner / spacer), and a body-less read
// (leading spacer) are stacked as they'd appear inline. All three leading slots are
// the same size-3 column, so every wrench - chevron row, spinner row, spacer row -
// shares one vertical edge. The spinner only ever rides in that gutter to the left.
export const AlignsInTranscript: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-col gap-1">
        <ToolCall name="bash" args="pnpm --filter @trevor/web typecheck" status="done">
          <span className="text-sm">(no errors)</span>
        </ToolCall>
        <ConcurrentTools tools={withStatus({ r1: "done", gl: "done" }, "running")} />
        <ToolCall
          name="read"
          args="apps/web/src/main.tsx"
          status="done"
          onOpenPath={() => openInEditor("apps/web/src/main.tsx")}
        />
      </div>
    </Frame>
  ),
};
