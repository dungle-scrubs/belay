import type { Meta, StoryObj } from "@storybook/react-vite";
import { storyFrame } from "@/components/chat/story-frame";
import { TranscriptRowView } from "@/components/chat/transcript-row-view";
import type { AssistantMessage } from "../../transcript";
import type { TranscriptRow } from "../../transcript-rows";
import { MessageMeta } from "./message";
import { ReasoningTrace } from "./reasoning-trace";

/**
 * Plan 35: the ghosted reasoning trace. The assistant's `assistant.thinking` string rendered as a
 * muted, de-emphasized disclosure that reads as secondary to the answer - collapsible, streaming-aware
 * (auto-open + shimmer while live, auto-collapse once settled), capped for long traces, and stable on
 * the `thinking` label. These states drive the Lane A visual baselines (hidden / collapsed / expanded /
 * streaming / long / markdown / compact / narrow) plus dark, high-contrast, and reduced-motion checks.
 */
const meta: Meta<typeof ReasoningTrace> = {
  title: "Chat/ReasoningTrace",
  component: ReasoningTrace,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof ReasoningTrace>;

const THINKING = `The user wants a short sample plan. Keep it to a numbered list, show a fenced code block so markdown rendering is visible, and link out once.`;

const THINKING_MD = `Breaking the request down:

1. **Constraints** - keep it short, ghosted, secondary to the answer
2. Reuse the existing disclosure so scroll never yanks

\`\`\`ts
const streaming = !done && !text;
\`\`\`

See [the scroll-follow contract](https://example.com) before touching auto-open.`;

const LONG = Array.from(
  { length: 40 },
  (_, i) =>
    `Step ${i + 1}: consider the ${i % 2 ? "edge case" : "happy path"} and note what it implies for the plan.`,
).join("\n\n");

const Frame = storyFrame("w-[40rem]");

/** The settled default: reasoning is present but collapsed, so it never competes with the answer. */
export const Collapsed: Story = {
  render: () => (
    <Frame>
      <ReasoningTrace content={THINKING} />
    </Frame>
  ),
};

/** Manually (or plan-27-compact) expanded: the muted reasoning prose sits inside its ghosted box. */
export const Expanded: Story = {
  render: () => (
    <Frame>
      <ReasoningTrace content={THINKING} defaultOpen />
    </Frame>
  ),
};

/** Actively streaming: auto-opened with a shimmering trigger and a live bottom-pinned preview. */
export const Streaming: Story = {
  render: () => (
    <Frame>
      <ReasoningTrace content={THINKING} streaming />
    </Frame>
  ),
};

/** A long trace stays capped with an internal scroll box, so it never floods the transcript. */
export const Long: Story = {
  render: () => (
    <Frame>
      <ReasoningTrace content={LONG} defaultOpen />
    </Frame>
  ),
};

/** Markdown-rich reasoning: headings, lists, code, and links render through the shared markdown body. */
export const MarkdownRich: Story = {
  render: () => (
    <Frame>
      <ReasoningTrace content={THINKING_MD} defaultOpen />
    </Frame>
  ),
};

/** The compact affordance (plan 27): a one-line trigger carrying the label + line count, still expandable. */
export const Compact: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-col gap-3">
        <ReasoningTrace content={THINKING} compact />
        <ReasoningTrace content={THINKING} compact streaming />
      </div>
    </Frame>
  ),
};

/** Narrow viewport: the trigger label and chevron stay readable and the prose wraps without overlap. */
export const Narrow: Story = {
  render: () => (
    <div className="w-[18rem] max-w-full">
      <ReasoningTrace content={THINKING_MD} defaultOpen />
    </div>
  ),
};

/** Dark mode: the ghosted treatment stays muted and legible against the dark surface. */
export const Dark: Story = {
  render: () => (
    <div className="dark bg-background p-4 text-foreground">
      <Frame>
        <ReasoningTrace content={THINKING} defaultOpen />
      </Frame>
    </div>
  ),
};

/** High-contrast: the muted trigger and prose remain distinguishable. */
export const HighContrast: Story = {
  render: () => (
    <div className="bg-background p-4 text-foreground contrast-more:border contrast-more:border-foreground">
      <Frame>
        <ReasoningTrace content={THINKING} defaultOpen />
      </Frame>
    </div>
  ),
};

/**
 * Reduced motion: the streaming shimmer carries `motion-reduce:animate-none`, so users with
 * `prefers-reduced-motion: reduce` see the static label instead of an animated distraction.
 */
export const ReducedMotion: Story = {
  render: () => (
    <Frame>
      <div className="motion-reduce:*:animate-none">
        <ReasoningTrace content={THINKING} streaming />
      </div>
    </Frame>
  ),
};

// --- Row-level compositions on the production TranscriptRowView (plan 35 M3/M4) ---

const assistantRow = (over: Partial<AssistantMessage>): TranscriptRow => ({
  kind: "message",
  id: "message:a1",
  compactAbove: false,
  message: {
    kind: "assistant",
    id: "a1",
    runId: "r1",
    text: "",
    thinking: "",
    done: true,
    warm: true,
    model: "qwen3.6-27b-mlx",
    ...over,
  },
});

const noop = () => {};

const Row = ({ row }: { row: TranscriptRow }) => (
  <Frame>
    <TranscriptRowView row={row} showThinking onOpenPath={noop} onDoctorRefresh={noop} />
  </Frame>
);

/** Hidden: with the `show thinking` preference off, the reasoning trace never appears - only the answer. */
export const RowThinkingHidden: Story = {
  render: () => (
    <Frame>
      <TranscriptRowView
        row={assistantRow({
          thinking: THINKING,
          text: "Here is the plan: scaffold, build, verify.",
          done: true,
        })}
        showThinking={false}
        onOpenPath={noop}
        onDoctorRefresh={noop}
      />
    </Frame>
  ),
};

/** A live thinking-only turn: the reasoning auto-opens above the (not-yet-arrived) answer. */
export const RowStreamingThinking: Story = {
  render: () => <Row row={assistantRow({ thinking: THINKING, text: "", done: false })} />,
};

/** A settled answer: the reasoning has collapsed back to its ghosted trigger, answer + meta below. */
export const RowSettledAnswer: Story = {
  render: () => (
    <Row
      row={assistantRow({
        thinking: THINKING,
        text: "Here is the plan: scaffold, build, verify.",
        done: true,
        usage: {
          input: 3300,
          output: 120,
          contextWindow: 8000,
          genMs: 8000,
        },
      })}
    />
  ),
};

/** Error-adjacent: the reasoning trace sits quietly above the destructive error alert. */
export const RowErrorAdjacent: Story = {
  render: () => (
    <Row
      row={assistantRow({
        thinking: THINKING,
        text: "",
        error: "provider stream closed unexpectedly",
      })}
    />
  ),
};

/** Interrupted-adjacent: reasoning above a partial answer and the muted interrupted note. */
export const RowInterruptedAdjacent: Story = {
  render: () => (
    <Row
      row={assistantRow({
        thinking: THINKING,
        text: "Here is the plan so far",
        interrupted: true,
      })}
    />
  ),
};

/** The MessageMeta line is unaffected by the ghosted reasoning above it. */
export const RowMetaOnly: Story = {
  render: () => (
    <Frame>
      <MessageMeta items={["qwen3.6-27b-mlx", "3.3k/8k ctx", "15 tok/s"]} />
    </Frame>
  ),
};
