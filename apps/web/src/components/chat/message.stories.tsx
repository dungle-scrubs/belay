import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  AssistantMessage,
  CommandMessage,
  CommandResult,
  MessageHeading,
  MessageMeta,
  ThinkingMessage,
  ToolCall,
  UserMessage,
  WorkingIndicator,
} from "./message";

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

const THINKING = `The user wants a short sample plan. Keep it to a numbered list,
show a fenced code block so markdown rendering is visible, and link out once.`;

const DOCTOR = `workspace: ~/dev/trevorV2/apps/agent-host
host: 1d8e680d (leader)

providers:
  qwen - Qwen (local) (qwen3.6-27b-mlx) - warm
  gpt - GPT-5.5 (gpt-5.5) - warm

tools: read, bash, write, edit, glob, grep, skill`;

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div className="w-[40rem] max-w-full">{children}</div>
);

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

export const Working: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <WorkingIndicator />
      <WorkingIndicator label="thinking" />
      <WorkingIndicator label="loading qwen" />
    </div>
  ),
};

export const Tool: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-col gap-3">
        <ToolCall name="read" args="apps/web/src/App.tsx" status="done" />
        <ToolCall name="bash" args="pnpm typecheck" status="running" />
        <ToolCall name="edit" args="index.css" status="error" />
        <ToolCall name="grep" args="useRichterSession" status="done">
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

export const Thinking: Story = {
  render: () => (
    <Frame>
      <ThinkingMessage content={THINKING} />
    </Frame>
  ),
};

export const Command: Story = {
  render: () => (
    <Frame>
      <CommandMessage command="/shell" args="echo hello && node -v" />
    </Frame>
  ),
};

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
        <CommandMessage command="/doctor" />
        <CommandResult command="/doctor" text={DOCTOR} />
        <UserMessage text="create a sample plan using lucid" />
        <ThinkingMessage content={THINKING} defaultOpen={false} />
        <AssistantMessage
          content={RESPONSE}
          meta={<MessageMeta items={["qwen3.6-27b-mlx", "3.3k/8k ctx", "15 tok/s"]} />}
        />
        <ToolCall name="read" args="apps/web/src/App.tsx" status="done" />
        <WorkingIndicator />
      </div>
    </Frame>
  ),
};
