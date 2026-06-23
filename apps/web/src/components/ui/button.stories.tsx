import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./button";

const meta = {
  title: "Components/Button",
  component: Button,
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "destructive", "outline", "secondary", "ghost", "link"],
    },
    size: { control: "select", options: ["default", "sm", "lg", "icon"] },
  },
  args: { children: "commit", variant: "default", size: "default" },
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button>commit</Button>
      <Button variant="secondary">stage</Button>
      <Button variant="outline">cancel</Button>
      <Button variant="ghost" size="sm">
        abort
      </Button>
      <Button variant="destructive">purge</Button>
      <Button variant="link">details</Button>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm">small</Button>
      <Button size="default">default</Button>
      <Button size="lg">large</Button>
    </div>
  ),
};
