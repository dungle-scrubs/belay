import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";

const meta = {
  title: "Components/ToggleGroup",
  component: ToggleGroup,
  parameters: { layout: "centered" },
  args: { type: "single" },
} satisfies Meta<typeof ToggleGroup>;

export default meta;

type Story = StoryObj<typeof meta>;

const onClasses =
  "text-ui lowercase data-[state=on]:bg-primary data-[state=on]:text-primary-foreground";

// Reasoning on/off segmented control (single-select).
export const Reasoning: Story = {
  render: () => (
    <ToggleGroup type="single" defaultValue="on" variant="outline" size="sm">
      <ToggleGroupItem value="off" className={onClasses}>
        off
      </ToggleGroupItem>
      <ToggleGroupItem value="on" className={onClasses}>
        on
      </ToggleGroupItem>
    </ToggleGroup>
  ),
};

export const Levels: Story = {
  render: () => (
    <ToggleGroup type="single" defaultValue="medium" variant="outline" size="sm">
      <ToggleGroupItem value="low" className={onClasses}>
        low
      </ToggleGroupItem>
      <ToggleGroupItem value="medium" className={onClasses}>
        medium
      </ToggleGroupItem>
      <ToggleGroupItem value="high" className={onClasses}>
        high
      </ToggleGroupItem>
    </ToggleGroup>
  ),
};
