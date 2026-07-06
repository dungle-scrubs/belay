import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Message } from "@/transcript";
import type { TranscriptRow } from "@/transcript-rows";
import { AgentDetailShell } from "./agent-detail-shell";

/**
 * Plan 09.4 M6: the inline-agent detail takeover. Storybook proves the center-column surface renders a
 * delegated child's OWN transcript through the same row components as the main chat, with the shared
 * back button + an agent-named header. A fixed-size `Panel` frame stands in for the takeover slot.
 */
const meta: Meta<typeof AgentDetailShell> = {
  title: "AgentDetail/AgentDetailShell",
  component: AgentDetailShell,
  parameters: { layout: "fullscreen" },
};

export default meta;

type Story = StoryObj<typeof AgentDetailShell>;

const NOOP = () => {};

const messageRow = (id: string, message: Message): TranscriptRow => ({
  kind: "message",
  id: `message:${id}`,
  compactAbove: false,
  message,
});

const childTranscript: readonly TranscriptRow[] = [
  messageRow("u", {
    kind: "user",
    id: "u",
    text: "search for the failing assertion",
    artifacts: [],
    pastes: [],
  }),
  messageRow("a1", {
    kind: "assistant",
    id: "a1",
    runId: "cr1",
    text: "",
    thinking: "Scanning the auth tests…",
    done: false,
    warm: true,
    model: "qwen3-coder",
  }),
  messageRow("a2", {
    kind: "assistant",
    id: "a2",
    runId: "cr1",
    text: "The failing assertion is in `src/auth.ts:42` - the token check returns undefined.",
    thinking: "",
    done: true,
    warm: true,
    model: "qwen3-coder",
  }),
];

/** A fixed-size takeover frame, since the shell fills its parent (`h-full` in the app slot). */
function Panel({ children }: { children: React.ReactNode }) {
  return <div className="h-svh w-full max-w-3xl border border-border">{children}</div>;
}

/** A running child: its streaming turn is visible in the takeover. */
export const RunningChild: Story = {
  render: () => (
    <Panel>
      <AgentDetailShell agent="explorer" rows={childTranscript} onBack={NOOP} onOpenPath={NOOP} />
    </Panel>
  ),
};

/** A finished child: the task prompt then the final distilled answer. */
const doneTranscript: readonly TranscriptRow[] = [
  messageRow("u", {
    kind: "user",
    id: "u",
    text: "search for the failing assertion",
    artifacts: [],
    pastes: [],
  }),
  messageRow("a2", {
    kind: "assistant",
    id: "a2",
    runId: "cr1",
    text: "The failing assertion is in `src/auth.ts:42` - the token check returns undefined.",
    thinking: "",
    done: true,
    warm: true,
    model: "qwen3-coder",
  }),
];

export const DoneChild: Story = {
  render: () => (
    <Panel>
      <AgentDetailShell agent="explorer" rows={doneTranscript} onBack={NOOP} onOpenPath={NOOP} />
    </Panel>
  ),
};

/** Empty state: the child hasn't produced output yet (still worth a clear takeover, not a blank void). */
export const EmptyChild: Story = {
  render: () => (
    <Panel>
      <AgentDetailShell agent="planner" rows={[]} onBack={NOOP} onOpenPath={NOOP} />
    </Panel>
  ),
};
