import type { Meta, StoryObj } from "@storybook/react-vite";
import type { QueuedPrompt } from "@/send-queue";
import { QueuedPrompts } from "./queued-prompts";
import { storyFrame } from "./story-frame";

/**
 * The durable follow-up queue panel (plan 47): the prompts published behind the active turn, waiting on
 * the host. Each row is durable (it survives a reload / host restart) and carries an unqueue control
 * that supersedes it on the log. First Escape folds the whole queue into one steering prompt; Up at an
 * empty composer pulls the newest back to edit. These stories cover the single, multi, and
 * with-artifacts states the visual-regression lane (plan 09.2) baselines.
 */
const meta: Meta<typeof QueuedPrompts> = {
  title: "Chat/QueuedPrompts",
  component: QueuedPrompts,
  args: { onUnqueue: () => {} },
};
export default meta;

type Story = StoryObj<typeof QueuedPrompts>;

const Frame = storyFrame("w-[32rem]");

const prompt = (id: string, text: string): QueuedPrompt => ({ id, text, provider: "qwen" });

export const Single: Story = {
  args: { queue: [prompt("ev-1", "also update the changelog when you're done")] },
  render: (args) => (
    <Frame>
      <QueuedPrompts {...args} />
    </Frame>
  ),
};

export const Multiple: Story = {
  args: {
    queue: [
      prompt("ev-1", "also update the changelog"),
      prompt("ev-2", "then run the linter"),
      prompt("ev-3", "and open a PR when green"),
    ],
  },
  render: (args) => (
    <Frame>
      <QueuedPrompts {...args} />
    </Frame>
  ),
};

export const WithArtifact: Story = {
  args: {
    queue: [
      {
        id: "ev-9",
        provider: "qwen",
        text: "match this mockup",
        artifacts: [
          {
            kind: "image",
            mimeType: "image/png",
            size: 2048,
            hash: "a".repeat(64),
            name: "mockup.png",
          },
        ],
      },
    ],
  },
  render: (args) => (
    <Frame>
      <QueuedPrompts {...args} />
    </Frame>
  ),
};
