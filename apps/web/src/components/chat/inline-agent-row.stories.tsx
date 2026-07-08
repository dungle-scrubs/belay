import type { Meta, StoryObj } from "@storybook/react-vite";
import { storyFrame } from "@/components/chat/story-frame";
import { TranscriptRowView } from "@/components/chat/transcript-row-view";
import type { InlineAgent } from "../../transcript";
import type { TranscriptRow } from "../../transcript-rows";
import { inlineAgent } from "./inline-agent-fixtures";
import { InlineAgentGroup, InlineAgentRow } from "./inline-agent-row";
import { ToolCall } from "./message";

/**
 * Plan 09.4 M1: the inline-agent transcript row. Storybook is the first proof - the row + group
 * render from fixtures (model / thinking / tokens) before any protocol change, so the compact
 * single-line form, the parallel `└` group, the status tones, and the compact variant are all
 * visible ahead of the host wiring. Centering is global; these stories use a fixed-width frame.
 */
const meta: Meta<typeof InlineAgentRow> = {
  title: "Chat/InlineAgentRow",
  component: InlineAgentRow,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof InlineAgentRow>;

const Frame = storyFrame("w-[40rem]");

// A frozen start so the elapsed cell renders a stable "12s" for visual baselines.
const STARTED_AT = Date.now() - 12_000;

const singleAgent = inlineAgent({ startedAt: STARTED_AT });
const parallelAgents = [
  inlineAgent({ childSessionId: "s::sub::a", agent: "explorer", startedAt: STARTED_AT }),
  inlineAgent({
    childSessionId: "s::sub::b",
    agent: "planner",
    status: "done",
    startedAt: undefined,
    tokens: 3100,
  }),
  inlineAgent({
    childSessionId: "s::sub::c",
    agent: "reviewer",
    status: "running",
    startedAt: STARTED_AT,
    tokens: 640,
  }),
  inlineAgent({
    childSessionId: "s::sub::d",
    agent: "auditor",
    status: "interrupted",
    startedAt: undefined,
    tokens: undefined,
  }),
] as const;

function inlineAgentRow(id: string, agents: readonly InlineAgent[]): TranscriptRow {
  return {
    kind: "message",
    id: `message:${id}`,
    compactAbove: false,
    message: {
      kind: "inlineAgent",
      id,
      parentRunId: "run-inline-agents",
      agents: [...agents],
    },
  };
}

/** A single running inline agent: a bare one-line row (no `└`), distinct from the bordered tool card. */
export const SingleRunning: Story = {
  render: () => (
    <Frame>
      <InlineAgentRow agent={singleAgent} />
    </Frame>
  ),
};

/** Beside a tool-call card, so the visual distinction (bare row vs bordered chip) is obvious. */
export const NextToToolCard: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-col gap-3">
        <ToolCall name="bash" args="pnpm test" status="running" />
        <InlineAgentRow agent={singleAgent} />
      </div>
    </Frame>
  ),
};

/** The four status tones: running (purple), done (green), failed (red), interrupted (yellow). */
export const StatusTones: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-col gap-2">
        <InlineAgentRow agent={inlineAgent({ status: "running", startedAt: STARTED_AT })} />
        <InlineAgentRow
          agent={inlineAgent({ status: "done", startedAt: undefined, tokens: 4200 })}
        />
        <InlineAgentRow
          agent={inlineAgent({ status: "failed", startedAt: undefined, tokens: 300 })}
        />
        <InlineAgentRow
          agent={inlineAgent({ status: "interrupted", startedAt: undefined, tokens: undefined })}
        />
      </div>
    </Frame>
  ),
};

/** Parallel inline agents from one parent turn: nested under a header with the `└` tree branch. */
export const ParallelGroup: Story = {
  render: () => (
    <Frame>
      <InlineAgentGroup agents={parallelAgents} />
    </Frame>
  ),
};

/** A single-agent group collapses to a bare row (no header, no branch) - the common case stays quiet. */
export const SingletonGroup: Story = {
  render: () => (
    <Frame>
      <InlineAgentGroup agents={[singleAgent]} />
    </Frame>
  ),
};

/** Compact variant: the thinking-level cell is dropped under width / count pressure. */
export const CompactVariant: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-col gap-2">
        <InlineAgentRow agent={inlineAgent({ startedAt: STARTED_AT })} variant="full" />
        <InlineAgentRow agent={inlineAgent({ startedAt: STARTED_AT })} variant="compact" />
      </div>
    </Frame>
  ),
};

/** Clickable: wiring `onOpen` makes the whole line the target that opens the child transcript (M6). */
export const Clickable: Story = {
  render: () => (
    <Frame>
      <InlineAgentGroup
        agents={parallelAgents.slice(0, 2)}
        onOpen={(id) => console.log("open", id)}
      />
    </Frame>
  ),
};

/** Compact transcript mode still takes the full inline-agent path: one clickable row per child. */
export const CompactTranscriptExemption: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-col gap-4">
        <TranscriptRowView
          row={inlineAgentRow("ia-single", [singleAgent])}
          showThinking
          onOpenPath={() => undefined}
          onDoctorRefresh={() => undefined}
          onOpenAgent={(id) => console.log("open", id)}
          compact
        />
        <TranscriptRowView
          row={inlineAgentRow("ia-parallel", parallelAgents)}
          showThinking
          onOpenPath={() => undefined}
          onDoctorRefresh={() => undefined}
          onOpenAgent={(id) => console.log("open", id)}
          compact
        />
      </div>
    </Frame>
  ),
};
