import type { Meta, StoryObj } from "@storybook/react-vite";
import { LOOP_FAMILY } from "@/commands/loop";
import { LoopKeywords } from "./loop-keywords";

const meta = {
  title: "Chat/Loop/Keywords",
  component: LoopKeywords,
  parameters: { layout: "padded" },
  args: { descriptor: LOOP_FAMILY },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[26rem] max-w-full border border-border bg-popover p-3">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LoopKeywords>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The strip with nothing typed yet: every keyword dim. */
export const Default: Story = {};

/** Some keywords used (`every`, `until`, `do`) light up; the rest stay dim. */
export const WithUsedKeywords: Story = {
  args: { usedKeywords: ["every", "until", "do"] },
};
