import type { Meta, StoryObj } from "@storybook/react-vite";
import { Checkbox } from "./checkbox";
import { Label } from "./label";

const meta = {
  title: "Components/Checkbox",
  component: Checkbox,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Checkbox>;

export default meta;

type Story = StoryObj<typeof meta>;

const labelClasses = "cursor-pointer text-label tracking-wider uppercase text-muted-foreground";

export const ShowThinking: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Checkbox id="show-thinking" defaultChecked />
        <Label htmlFor="show-thinking" className={labelClasses}>
          show thinking
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="auto-scroll" />
        <Label htmlFor="auto-scroll" className={labelClasses}>
          auto scroll
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="locked" disabled defaultChecked />
        <Label htmlFor="locked" className={labelClasses}>
          locked
        </Label>
      </div>
    </div>
  ),
};
