import type { Meta, StoryObj } from "@storybook/react-vite";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

const meta = {
  title: "Components/Select",
  component: Select,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Select>;

export default meta;

type Story = StoryObj<typeof meta>;

// The provider/model picker from the composer header.
export const Model: Story = {
  render: () => (
    <Select defaultValue="qwen">
      <SelectTrigger size="sm" className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="qwen">Qwen 27B 4-bit (local)</SelectItem>
        <SelectItem value="gpt">GPT-5.5</SelectItem>
      </SelectContent>
    </Select>
  ),
};
