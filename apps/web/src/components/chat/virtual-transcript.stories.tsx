import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { createScrollFollowController } from "@/scroll-follow";
import type { Message } from "../../transcript";
import type { TranscriptRow } from "../../transcript-rows";
import { toolMessage } from "./compact-catalog-fixtures";
import { VirtualTranscript } from "./virtual-transcript";

/**
 * Plan 05 (M3): the same transcript fixture rendered in regular vs compact mode, and a live-running
 * compact transcript. Compact collapses non-primary rows (thinking, tools, command/shell results,
 * status markers) to one line while user prompts + the final assistant response stay full - toggling
 * the `compact` flag is the only difference between the Regular and Compact stories.
 */

const meta: Meta<typeof VirtualTranscript> = {
  title: "Chat/VirtualTranscript",
  component: VirtualTranscript,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof VirtualTranscript>;

const row = (message: Message): TranscriptRow => ({
  kind: "message",
  id: `message:${message.id}`,
  message,
  compactAbove: message.kind === "tool",
});

const ROWS: readonly TranscriptRow[] = [
  row({
    kind: "user",
    id: "u1",
    text: "Refactor the turn loop and run the tests.",
    artifacts: [],
    pastes: [],
  }),
  row({
    kind: "assistant",
    id: "a1",
    runId: "r1",
    text: "",
    thinking: "First I'll read the loop, then grep for the call sites before editing.",
    done: true,
    warm: false,
    model: "glm",
  }),
  row(
    toolMessage(
      "t1",
      "read",
      { path: "apps/agent-host/src/turn-loop.ts" },
      "export function runTurn() {…}",
    ),
  ),
  row(toolMessage("t2", "grep", { pattern: "runTurn", path: "apps/agent-host/src" }, "12 matches")),
  row(toolMessage("t3", "edit", { path: "apps/agent-host/src/turn-loop.ts" }, "applied 1 edit")),
  row(toolMessage("t4", "bash", { command: "pnpm test" }, "error: 2 tests failed")),
  row({
    kind: "shell",
    id: "s1",
    requestId: "rq1",
    command: "git status",
    done: true,
    ok: true,
    output: "clean",
  }),
  row({
    kind: "recovered",
    id: "rec1",
    action: "Trimmed a tool result",
    detail: "freed ~2k tokens",
    reclaimed: 2048,
  }),
  row({
    kind: "assistant",
    id: "a2",
    runId: "r1",
    text: "I refactored `runTurn` into smaller steps and fixed the two failing tests. The suite is green now.",
    thinking: "the fix was an off-by-one in the step budget",
    done: true,
    warm: false,
    model: "glm",
  }),
];

const RUNNING_ROWS: readonly TranscriptRow[] = [
  ...ROWS.slice(0, 4),
  row(toolMessage("t5", "bash", { command: "pnpm build" })), // no result -> still running
  // A plain turn (no task, no delegation) trails the inline "working…" row as its last item, with the
  // same time/tokens parens the pinned header shows (elapsed omitted here so the story stays static).
  { kind: "working", id: "working", outputTokens: 234800 },
];

// A brand-new thread: the working row sits right under the couple of messages, not floated at the
// bottom of a tall viewport (it flows as the last transcript item).
const SHORT_WORKING_ROWS: readonly TranscriptRow[] = [
  row({
    kind: "user",
    id: "sw-u1",
    text: "Add a health check endpoint.",
    artifacts: [],
    pastes: [],
  }),
  { kind: "working", id: "working" },
];

function longAnswer(index: number): string {
  return Array.from(
    { length: (index % 4) + 2 },
    (_, line) =>
      `resize stress answer ${index}.${line}: this paragraph is intentionally long enough to wrap when the project sidebar changes width, so the virtualizer has to preserve the reader anchor.`,
  ).join("\n\n");
}

const LONG_ROWS: readonly TranscriptRow[] = Array.from({ length: 90 }, (_, index) => [
  row({
    kind: "user",
    id: `long-u-${index}`,
    text: `Review transcript virtualization behavior for section ${index}.`,
    artifacts: [],
    pastes: [],
  }),
  row({
    kind: "assistant",
    id: `long-a-${index}`,
    runId: `long-${index}`,
    text: longAnswer(index),
    thinking: index % 5 === 0 ? "checking scroll measurements before responding" : "",
    done: true,
    warm: false,
    model: "glm",
  }),
  ...(index % 6 === 0
    ? [
        row(
          toolMessage(
            `long-tool-${index}`,
            "grep",
            { pattern: "scroll", path: "apps/web/src" },
            longAnswer(index),
          ),
        ),
      ]
    : []),
]).flat();

const STREAMING_ROWS: readonly TranscriptRow[] = [
  ...LONG_ROWS.slice(0, 36),
  row({
    kind: "user",
    id: "stream-u",
    text: "Keep following while this answer streams.",
    artifacts: [],
    pastes: [],
  }),
  row({
    kind: "assistant",
    id: "stream-a",
    runId: "stream",
    text: Array.from({ length: 18 }, (_, index) => `streaming pinned line ${index}`).join("\n"),
    thinking: "building the answer incrementally",
    done: false,
    warm: false,
    model: "glm",
  }),
];

function Frame({
  rows,
  compact,
  pinned = false,
}: {
  rows: readonly TranscriptRow[];
  compact: boolean;
  pinned?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef(createScrollFollowController({ initialPinned: pinned }));
  return (
    <div
      ref={scrollRef}
      style={{ width: 760, height: 520, flexShrink: 0 }}
      className="overflow-auto rounded-lg border border-border bg-background px-4 py-3"
    >
      <VirtualTranscript
        rows={rows}
        scrollRef={scrollRef}
        controller={controllerRef.current}
        scrollToBottomRequest={0}
        rowConfig={{ showThinking: true, compact, onOpenPath: () => {}, onDoctorRefresh: () => {} }}
      />
    </div>
  );
}

export const WorkingRow: Story = {
  render: () => <Frame rows={RUNNING_ROWS} compact={false} />,
};

export const WorkingRowShortThread: Story = {
  render: () => <Frame rows={SHORT_WORKING_ROWS} compact={false} />,
};

export const WorkingRowCompact: Story = {
  render: () => <Frame rows={RUNNING_ROWS} compact />,
};

function SidebarResizeFrame() {
  const [width, setWidth] = useState(320);
  const startRef = useRef<{ readonly x: number; readonly width: number } | null>(null);
  return (
    <div className="flex h-screen bg-smui-surface-sunken">
      <aside className="relative shrink-0 border-r border-border bg-sidebar" style={{ width }}>
        <div className="p-4 font-mono text-xs tracking-wider text-muted-foreground">
          project sidebar
        </div>
        <button
          type="button"
          aria-label="Resize sidebar"
          className="absolute top-0 right-0 h-full w-2 bg-foreground/10 hover:bg-foreground/20"
          onMouseDown={(event) => {
            startRef.current = { x: event.clientX, width };
            const onMove = (move: MouseEvent) => {
              const start = startRef.current;
              if (!start) {
                return;
              }
              setWidth(Math.max(180, Math.min(480, start.width + move.clientX - start.x)));
            };
            const onUp = () => {
              startRef.current = null;
              document.removeEventListener("mousemove", onMove);
              document.removeEventListener("mouseup", onUp);
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
          }}
        />
      </aside>
      <main className="min-w-0 flex-1 p-4">
        <Frame rows={LONG_ROWS} compact={false} />
      </main>
    </div>
  );
}

export const Regular: Story = {
  render: () => <Frame rows={ROWS} compact={false} />,
};

export const Compact: Story = {
  render: () => <Frame rows={ROWS} compact />,
};

export const LiveRunningCompact: Story = {
  render: () => <Frame rows={RUNNING_ROWS} compact />,
};

export const LongTranscript: Story = {
  render: () => <Frame rows={LONG_ROWS} compact={false} />,
};

export const CompactLongTranscript: Story = {
  render: () => <Frame rows={LONG_ROWS} compact />,
};

export const StreamingBottomPinned: Story = {
  render: () => <Frame rows={STREAMING_ROWS} compact={false} pinned />,
};

export const UnpinnedReadingState: Story = {
  render: () => <Frame rows={LONG_ROWS} compact={false} />,
};

export const SidebarResizeStress: Story = {
  render: () => <SidebarResizeFrame />,
};
