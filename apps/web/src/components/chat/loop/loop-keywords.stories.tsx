import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CommandKeywordChip } from "@trevor/session";
import { LOOP_FAMILY } from "@trevor/session";
import { LoopKeywords } from "./loop-keywords";

/** Build the keyword chips (the presentation view-model's `chips`) for the loop family. */
const chips = (used: readonly string[] = []): CommandKeywordChip[] =>
  LOOP_FAMILY.keywords.map((keyword) => ({
    keyword: keyword.keyword,
    arg: keyword.arg,
    used: used.includes(keyword.keyword),
  }));

const meta = {
  title: "Chat/Loop/Keywords",
  component: LoopKeywords,
  parameters: { layout: "padded" },
  args: { chips: chips() },
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
  args: { chips: chips(["every", "until", "do"]) },
};
