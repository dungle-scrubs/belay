import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef } from "react";
import { createScrollFollowController } from "@/scroll-follow";
import type { Message } from "../../transcript";
import type { TranscriptRow } from "../../transcript-rows";
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

function tool(id: string, name: string, args: object, result?: string): Message {
  return {
    kind: "tool",
    id,
    name,
    args: JSON.stringify(args),
    done: result !== undefined,
    ...(result !== undefined ? { result } : {}),
  };
}

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
    tool(
      "t1",
      "read",
      { path: "apps/agent-host/src/turn-loop.ts" },
      "export function runTurn() {…}",
    ),
  ),
  row(tool("t2", "grep", { pattern: "runTurn", path: "apps/agent-host/src" }, "12 matches")),
  row(tool("t3", "edit", { path: "apps/agent-host/src/turn-loop.ts" }, "applied 1 edit")),
  row(tool("t4", "bash", { command: "pnpm test" }, "error: 2 tests failed")),
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
  row(tool("t5", "bash", { command: "pnpm build" })), // no result -> still running
  // The live-turn indicator is the pinned TurnStatusHeader (plan 50), not a transcript row.
];

function Frame({ rows, compact }: { rows: readonly TranscriptRow[]; compact: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Unpinned from the start: the catalog shows the transcript top-anchored, not snapped to the edge.
  const controllerRef = useRef(createScrollFollowController({ initialPinned: false }));
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

export const Regular: Story = {
  render: () => <Frame rows={ROWS} compact={false} />,
};

export const Compact: Story = {
  render: () => <Frame rows={ROWS} compact />,
};

export const LiveRunningCompact: Story = {
  render: () => <Frame rows={RUNNING_ROWS} compact />,
};
