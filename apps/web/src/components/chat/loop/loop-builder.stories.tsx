import type { Meta, StoryObj } from "@storybook/react-vite";
import { parseLoopCommand } from "@/commands/loop-parser";
import { LoopBuilder } from "./loop-builder";

const meta = {
  title: "Chat/Loop/Builder",
  component: LoopBuilder,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[26rem] max-w-full border border-border bg-popover p-3">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LoopBuilder>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A complete, valid loop: every field set, ready, Confirm enabled. */
export const Ready: Story = {
  args: { parse: parseLoopCommand('/loop every 5m until "tests pass" do "run the suite"') },
};

/** Just `/loop` - both required parts (action and a bound) flagged as gaps. */
export const Incomplete: Story = {
  args: { parse: parseLoopCommand("/loop") },
};

/** Has an action but no bound yet - one gap remaining. */
export const MissingBound: Story = {
  args: { parse: parseLoopCommand('/loop do "watch the build"') },
};

/** Value errors: a bad duration and a non-positive max both block readiness. */
export const WithErrors: Story = {
  args: { parse: parseLoopCommand('/loop every 5flarn max 0 do "x"') },
};

/** A shell-command loop on a cadence (process runner). */
export const ProcessLoop: Story = {
  args: { parse: parseLoopCommand('/loop process durable every 30s do "curl -sf localhost:8080"') },
};
