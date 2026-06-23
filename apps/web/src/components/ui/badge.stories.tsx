import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "./badge";

const meta = {
  title: "Components/Badge",
  component: Badge,
  args: { children: "active", variant: "outline" },
} satisfies Meta<typeof Badge>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ActiveInactive: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className="text-primary border-primary/30">
        active
      </Badge>
      <Badge variant="outline" className="text-muted-foreground">
        inactive
      </Badge>
    </div>
  ),
};

// Aurora status colors, mapped to the documented semantic states. Uses the
// registered smui-* color utilities (text-smui-green, border-smui-green/30).
export const StatusBadges: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge
        variant="outline"
        className="text-label tracking-wider uppercase text-smui-green border-smui-green/30"
      >
        online
      </Badge>
      <Badge
        variant="outline"
        className="text-label tracking-wider uppercase text-smui-yellow border-smui-yellow/30"
      >
        standby
      </Badge>
      <Badge
        variant="outline"
        className="text-label tracking-wider uppercase text-smui-orange border-smui-orange/30"
      >
        degraded
      </Badge>
      <Badge
        variant="outline"
        className="text-label tracking-wider uppercase text-smui-red border-smui-red/30"
      >
        critical
      </Badge>
      <Badge
        variant="outline"
        className="text-label tracking-wider uppercase text-smui-purple border-smui-purple/30"
      >
        rare
      </Badge>
    </div>
  ),
};
