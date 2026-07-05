import type { Meta, StoryObj } from "@storybook/react-vite";
import { storyFrame } from "@/components/chat/story-frame";
import { TurnStatusHeader } from "./turn-status-header";

/**
 * The pinned live turn-status line (plan 50): one action headline plus a muted metrics parenthetical
 * `(<elapsed> · ↓ <output> tokens · <state>)`. These variants pin the four shapes the projection can
 * hand it - a task-authored headline with a distinct engine state, a no-task turn whose headline IS
 * the state (redundant state dropped), a running-tool headline, and the pre-first-progress state where
 * the `↓` token cell is hidden. `startedAt` is frozen so the elapsed timer renders a stable baseline.
 */
const meta: Meta<typeof TurnStatusHeader> = {
  title: "Chat/TurnStatusHeader",
  component: TurnStatusHeader,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof TurnStatusHeader>;

const Frame = storyFrame("w-[40rem]");

/** A frozen start so the elapsed cell renders a stable label for visual baselines. */
const startedSecondsAgo = (seconds: number) => Date.now() - seconds * 1000;

/**
 * A task is in progress: the headline is the task's present-progressive `activeForm`, and the trailing
 * engine `state` ("thinking") is distinct, so it is shown - `Adding schemas and tests… (2m 37s · ↓
 * 2.6k tokens · thinking)`.
 */
export const TaskActive: Story = {
  render: () => (
    <Frame>
      <TurnStatusHeader
        headline="Adding schemas and tests…"
        startedAt={startedSecondsAgo(157)}
        outputTokens={2600}
        state="thinking"
      />
    </Frame>
  ),
};

/**
 * No task is in progress: the headline falls back to the engine state, so headline === state and the
 * redundant trailing cell is dropped - `thinking (2m 37s · ↓ 2.6k tokens)`.
 */
export const NoTask: Story = {
  render: () => (
    <Frame>
      <TurnStatusHeader
        headline="thinking"
        startedAt={startedSecondsAgo(157)}
        outputTokens={2600}
        state="thinking"
      />
    </Frame>
  ),
};

/**
 * A tool is running with no task: the headline is the tool verb, which is also the state, so the state
 * cell is dropped - `reading src/foo.ts (12s · ↓ 340 tokens)`.
 */
export const ToolRunning: Story = {
  render: () => (
    <Frame>
      <TurnStatusHeader
        headline="reading src/foo.ts"
        startedAt={startedSecondsAgo(12)}
        outputTokens={340}
        state="reading src/foo.ts"
      />
    </Frame>
  ),
};

/** Before the first `assistant.progress`: no output count yet, so the `↓` token cell is hidden. */
export const NoTokensYet: Story = {
  render: () => (
    <Frame>
      <TurnStatusHeader headline="Working" startedAt={startedSecondsAgo(3)} state="Working" />
    </Frame>
  ),
};
