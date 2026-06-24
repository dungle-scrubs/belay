import type { Meta, StoryObj } from "@storybook/react-vite";
import type { UsageBreakdown } from "@trevor/session";
import { SidePanel } from "./SidePanel";

// A realistic turn: tool results dominate the input, thinking dominates the
// output, the answer is a slice, plus the fixed prompt overhead.
const breakdown: UsageBreakdown = {
  input: {
    systemAndTools: 2400,
    userText: 820,
    assistantText: 640,
    toolCallArgs: 520,
    toolResults: 9800,
    imagesBase64: 0,
    imageCount: 0,
    byTool: { read: 4200, bash: 2600, grep: 1800, edit: 1200 },
  },
  output: { thinking: 3800, answer: 1900, toolCallArgs: 520 },
};

// The whole context window: every request so far, accumulated. Tool results
// dominate as read/bash/grep output piles up across the turns.
const contextBreakdown: UsageBreakdown = {
  input: {
    systemAndTools: 2400,
    userText: 6800,
    assistantText: 9200,
    toolCallArgs: 4100,
    toolResults: 78000,
    imagesBase64: 0,
    imageCount: 0,
    byTool: { read: 34000, bash: 21000, grep: 14000, edit: 9000 },
  },
  output: { thinking: 22000, answer: 12000, toolCallArgs: 4100 },
};

const Controls = (
  <>
    <button
      type="button"
      className="flex items-center justify-between border border-border px-3 py-2 text-sm hover:bg-secondary"
    >
      <span className="text-muted-foreground">model</span>
      <span className="text-foreground">qwen 4-bit ▾</span>
    </button>
    <button
      type="button"
      className="flex items-center justify-between border border-border px-3 py-2 text-sm hover:bg-secondary"
    >
      <span className="text-muted-foreground">reasoning</span>
      <span className="text-foreground">off ▾</span>
    </button>
  </>
);

const meta = {
  title: "Panel/SidePanel",
  component: SidePanel,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[680px] justify-end bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SidePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    title: "auth-flow",
    subtitle: "session · trevor-local",
    workspace: "~/proj/api",
    branch: "main",
    ctxUsed: 128000,
    ctxMax: 200000,
    totalTokens: 14100,
    breakdown,
    contextTokens: 128000,
    contextBreakdown,
    controls: Controls,
  },
};

export const NoImagesHeavyThinking: Story = {
  args: {
    title: "refactor-loop",
    subtitle: "session · trevor-local",
    workspace: "~/dev/trevorV2",
    branch: "main",
    ctxUsed: 82000,
    ctxMax: 200000,
    totalTokens: 8200,
    breakdown: {
      input: {
        systemAndTools: 2400,
        userText: 300,
        assistantText: 200,
        toolCallArgs: 180,
        toolResults: 2100,
        imagesBase64: 0,
        imageCount: 0,
        byTool: { read: 1500, grep: 600 },
      },
      output: { thinking: 5200, answer: 700, toolCallArgs: 180 },
    },
    controls: Controls,
  },
};

export const Empty: Story = {
  args: {
    title: "trevor-local",
    subtitle: "no call yet",
    workspace: "~/dev/trevorV2",
    ctxUsed: 0,
    ctxMax: 200000,
    controls: Controls,
  },
};
