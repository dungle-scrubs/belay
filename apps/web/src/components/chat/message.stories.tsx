import type { Meta, StoryObj } from "@storybook/react-vite";
import { storyFrame } from "@/components/chat/story-frame";
import { ActionShimmer } from "./action-shimmer";
import {
  AssistantMessage,
  CommandResult,
  MessageHeading,
  MessageMeta,
  ToolCall,
  UserMessage,
} from "./message";
import { ReasoningTrace } from "./reasoning-trace";

const meta: Meta = {
  title: "Chat/Messages",
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj;

const RESPONSE = `Here's a sample plan:

1. **Scaffold** the design system in \`apps/web\`
2. Build the composer and the chat message components
3. Verify everything in Storybook

\`\`\`ts
const plan = ["scaffold", "build", "verify"] as const;
\`\`\`

See [the SMUI guide](https://smui.statico.io) for the aesthetic.`;

const MERMAID_FLOW = `A deployment flow:

\`\`\`mermaid
flowchart TD
  Plan[Plan] --> Build[Build]
  Build --> Test{Tests pass?}
  Test -- yes --> Ship[Ship]
  Test -- no --> Fix[Fix]
  Fix --> Build
\`\`\``;

const MERMAID_SEQUENCE = `Provider turn sequence:

\`\`\`mermaid
sequenceDiagram
  participant User
  participant Web
  participant Host
  participant Model
  User->>Web: submit prompt
  Web->>Host: user.message
  Host->>Model: stream request
  Model-->>Host: deltas and tool calls
  Host-->>Web: transcript events
\`\`\``;

const MERMAID_STATE = `Turn lifecycle:

\`\`\`mermaid
stateDiagram-v2
  [*] --> Queued
  Queued --> Running
  Running --> WaitingForTool
  WaitingForTool --> Running
  Running --> Complete
  Running --> Interrupted
  Complete --> [*]
  Interrupted --> [*]
\`\`\``;

const MERMAID_INVALID = `Broken diagram source remains readable:

\`\`\`mermaid
graph TD
  A -->
\`\`\``;

const MERMAID_WIDE = `A wider dependency graph:

\`\`\`mermaid
flowchart LR
  Context[Context registry] --> Prompt[System prompt]
  Tasks[Task registry] --> Prompt
  Tools[Tool inventory] --> Prompt
  Prompt --> Provider[Provider request]
  Provider --> Stream[Stream events]
  Stream --> Transcript[Transcript rendering]
  Transcript --> Mermaid[Inline Mermaid block]
\`\`\``;

const THINKING = `The user wants a short sample plan. Keep it to a numbered list,
show a fenced code block so markdown rendering is visible, and link out once.`;

const DOCTOR = `workspace: ~/dev/trevor/apps/agent-host
host: 1d8e680d (leader)

providers:
  qwen - Qwen (local) (qwen3.6-27b-mlx) - warm
  gpt - GPT-5.5 (gpt-5.5) - warm

tools: read, bash, write, edit, glob, grep, skill`;

const Frame = storyFrame("w-[40rem]");

export const Headings: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      <MessageHeading>you</MessageHeading>
      <MessageHeading>assistant</MessageHeading>
      <MessageHeading>assistant · streaming</MessageHeading>
    </div>
  ),
};

export const MetaLine: Story = {
  render: () => <MessageMeta items={["qwen3.6-27b-mlx", "3.3k/8k ctx", "15 tok/s"]} />,
};

// The active-status shimmer's own label vocabulary/fallback/reduced-motion states live in
// action-shimmer.stories.tsx (plan 31); this catalog keeps only the compositions below that show
// it stitched into a realistic message sequence.

export const Tool: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-col gap-3">
        <ToolCall name="read" args="apps/web/src/app.tsx" status="done" />
        <ToolCall name="bash" args="pnpm typecheck" status="running" />
        <ToolCall name="edit" args="index.css" status="error" />
        <ToolCall name="grep" args="useTetherSession" status="done">
          3 matches in 2 files
        </ToolCall>
      </div>
    </Frame>
  ),
};

export const User: Story = {
  render: () => (
    <Frame>
      <UserMessage text="create a sample plan using lucid" />
    </Frame>
  ),
};

const PASTED_LOG = Array.from(
  { length: 36 },
  (_, i) => `2026-06-29T19:${10 + i}:04Z  GET /api/items/${i} 200 ${12 + i}ms`,
).join("\n");

export const UserWithPastedText: Story = {
  render: () => (
    <Frame>
      <UserMessage
        text="here is the failing request log [Pasted text #1 +36 lines] - why is the latency climbing?"
        pastes={[{ text: PASTED_LOG }]}
      />
    </Frame>
  ),
};

export const Assistant: Story = {
  render: () => (
    <Frame>
      <AssistantMessage
        content={RESPONSE}
        meta={<MessageMeta items={["qwen3.6-27b-mlx", "3.3k/8k ctx", "15 tok/s"]} />}
      />
    </Frame>
  ),
};

export const AssistantMermaidFlowchart: Story = {
  render: () => (
    <Frame>
      <AssistantMessage content={MERMAID_FLOW} />
    </Frame>
  ),
};

export const AssistantMermaidSequence: Story = {
  render: () => (
    <Frame>
      <AssistantMessage content={MERMAID_SEQUENCE} />
    </Frame>
  ),
};

export const AssistantMermaidState: Story = {
  render: () => (
    <Frame>
      <AssistantMessage content={MERMAID_STATE} />
    </Frame>
  ),
};

export const AssistantMermaidSyntaxError: Story = {
  render: () => (
    <Frame>
      <AssistantMessage content={MERMAID_INVALID} />
    </Frame>
  ),
};

export const AssistantMermaidWide: Story = {
  render: () => (
    <div className="w-[28rem]">
      <AssistantMessage content={MERMAID_WIDE} />
    </div>
  ),
};

export const AssistantMermaidDark: Story = {
  render: () => (
    <div className="dark bg-background p-4 text-foreground">
      <Frame>
        <AssistantMessage content={MERMAID_FLOW} />
      </Frame>
    </div>
  ),
};

export const AssistantMermaidHighContrast: Story = {
  render: () => (
    <div className="bg-background p-4 text-foreground contrast-more:border contrast-more:border-foreground">
      <Frame>
        <AssistantMessage content={MERMAID_SEQUENCE} />
      </Frame>
    </div>
  ),
};

export const AssistantMermaidStreaming: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-col gap-3">
        <AssistantMessage content={MERMAID_FLOW} />
        <ActionShimmer label="streaming" />
      </div>
    </Frame>
  ),
};

// The reasoning trace's own catalog (collapsed/expanded/streaming/long/compact/reduced-motion) lives
// in reasoning-trace.stories.tsx; this file keeps only the Conversation composition below that shows
// it stitched into a realistic message sequence (plan 35 M4).

export const Result: Story = {
  render: () => (
    <Frame>
      <CommandResult command="/doctor" text={DOCTOR} />
    </Frame>
  ),
};

// A realistic transcript stitched from the message components.
export const Conversation: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-col gap-5">
        <CommandResult command="/doctor" text={DOCTOR} />
        <UserMessage text="create a sample plan using lucid" />
        <ReasoningTrace content={THINKING} />
        <AssistantMessage
          content={RESPONSE}
          meta={<MessageMeta items={["qwen3.6-27b-mlx", "3.3k/8k ctx", "15 tok/s"]} />}
        />
        <ToolCall name="read" args="apps/web/src/app.tsx" status="done" />
        <ActionShimmer />
      </div>
    </Frame>
  ),
};
