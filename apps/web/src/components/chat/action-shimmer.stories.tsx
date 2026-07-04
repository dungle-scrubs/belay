import type { Meta, StoryObj } from "@storybook/react-vite";
import { storyFrame } from "@/components/chat/story-frame";
import { ActionShimmer } from "./action-shimmer";

const meta: Meta<typeof ActionShimmer> = {
  title: "Chat/ActionShimmer",
  component: ActionShimmer,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof ActionShimmer>;

const Frame = storyFrame("w-[40rem]");

// A frozen start time so the elapsed timer renders a stable "5m 29s" for visual baselines.
const FROZEN_STARTED_AT = Date.now() - (5 * 60 + 29) * 1000;

/** The full label vocabulary the projection can produce, each shimmering as an active status. */
export const LabelVocabulary: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-col gap-3">
        <ActionShimmer label="Working" />
        <ActionShimmer label="thinking" />
        <ActionShimmer label="applying steering" />
        <ActionShimmer label="reading apps/web/src/app.tsx" />
        <ActionShimmer label="searching useSlashMenu" />
        <ActionShimmer label="running pnpm test" />
        <ActionShimmer label="classifying with qwen" />
        <ActionShimmer label="reconnecting (attempt 2/5)" />
      </div>
    </Frame>
  ),
};

/** The fallback used when the event stream gives no better structured evidence. */
export const Fallback: Story = {
  args: { label: "Working" },
};

/** A cold model start: waiting on the provider to load. */
export const LoadingModel: Story = {
  args: { label: "loading qwen" },
};

/** The interruptible turn form: bold shimmering label with a live elapsed timer + esc hint. */
export const InterruptibleTurn: Story = {
  args: { label: "Working", startedAt: FROZEN_STARTED_AT, interruptible: true },
};

/** Elapsed timer without the esc hint (a non-interruptible in-flight action). */
export const ElapsedOnly: Story = {
  args: { label: "summarizing archive", startedAt: FROZEN_STARTED_AT },
};

/**
 * Reduced-motion: the shimmer band is disabled (`motion-reduce:animate-none`) and the solid base
 * label stays fully readable. Rendered inside a forced reduced-motion wrapper for the baseline.
 */
export const ReducedMotion: Story = {
  parameters: { chromatic: { prefersReducedMotion: "reduce" } },
  render: () => (
    <div style={{ ["--motion" as string]: "reduce" }}>
      <div className="flex flex-col gap-3 motion-reduce:contents">
        <ActionShimmer label="reading apps/web/src/app.tsx" />
        <ActionShimmer label="Working" startedAt={FROZEN_STARTED_AT} interruptible />
      </div>
    </div>
  ),
};
