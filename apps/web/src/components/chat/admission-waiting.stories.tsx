import type { Meta, StoryObj } from "@storybook/react-vite";
import { AdmissionWaitingRow } from "./admission-waiting";

/**
 * The local-model admission waiting row (plan 11 M7): the bounded live status a turn shows while it is
 * queued behind another project/subagent for a busy LM Studio resource.
 */
const meta: Meta<typeof AdmissionWaitingRow> = {
  title: "Chat/AdmissionWaitingRow",
  component: AdmissionWaitingRow,
};
export default meta;
type Story = StoryObj<typeof AdmissionWaitingRow>;

export const ForegroundFirstInLine: Story = {
  args: {
    waiting: {
      runId: "run-1",
      provider: "lmstudio",
      model: "qwen3.6-27b-mlx",
      priority: "foreground",
      position: 0,
    },
  },
};

export const ForegroundWaitingInLine: Story = {
  args: {
    waiting: {
      runId: "run-1",
      provider: "lmstudio",
      model: "qwen3.6-27b-mlx",
      priority: "foreground",
      position: 2,
    },
  },
};

export const BackgroundSubagent: Story = {
  args: {
    waiting: {
      runId: "child-1",
      provider: "lmstudio",
      model: "qwen3.6-27b-mlx",
      priority: "background",
      position: 1,
    },
  },
};

export const NotWaiting: Story = {
  args: { waiting: null },
};
