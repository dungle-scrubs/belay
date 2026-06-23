import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card";
import { Input } from "./input";
import { Label } from "./label";

const meta = {
  title: "Components/Card",
  component: Card,
  parameters: { layout: "padded" },
} satisfies Meta<typeof Card>;

export default meta;

type Story = StoryObj<typeof meta>;

// The canonical SMUI card: card-glow hover border, compact uppercase title,
// a status dot in the description, and a bordered data-display field.
export const Section: Story = {
  render: () => (
    <Card className="card-glow w-80">
      <CardHeader className="flex flex-row items-center justify-between py-2.5 px-3.5">
        <CardTitle className="text-xs text-muted-foreground tracking-[1.5px] uppercase font-normal">
          vessel config
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground flex items-center gap-1">
          <span className="inline-block w-[5px] h-[5px] rounded-full bg-smui-green" />
          online
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div>
          <span className="text-label text-muted-foreground tracking-[1.5px] uppercase block mb-1">
            system
          </span>
          <div className="text-sm px-2 py-1.5 bg-background border border-border text-primary">
            GAMMA DRACONIS
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="vessel-name"
            className="text-label text-muted-foreground tracking-[1.5px] uppercase"
          >
            vessel name
          </Label>
          <Input id="vessel-name" defaultValue="ISV Meridian" />
        </div>
        <Button size="sm" className="w-full mt-1">
          commit
        </Button>
      </CardContent>
    </Card>
  ),
};

// Stat card: big tracking-tight number with a green positive-change line.
export const Stat: Story = {
  render: () => (
    <Card className="card-glow w-56 p-2.5 px-3">
      <span className="text-label text-muted-foreground tracking-[1.5px] uppercase block">
        total credits
      </span>
      <div className="text-stat font-medium text-foreground tracking-tight">1,247,830</div>
      <div className="text-xs text-smui-green mt-0.5">+23,450 this cycle</div>
    </Card>
  ),
};
