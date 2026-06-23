import type { Meta, StoryObj } from "@storybook/react-vite";
import { cn } from "@/lib/utils";

const meta: Meta = {
  title: "Foundations/Colors",
  parameters: { layout: "fullscreen" },
};

export default meta;

type Story = StoryObj;

function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className={cn("h-14 w-full border border-border", className)} />
      <span className="text-label text-muted-foreground tracking-wider">{name}</span>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs text-muted-foreground tracking-[2px] uppercase">{label}</h2>
      <div className="grid grid-cols-2 gap-3 @sm:grid-cols-3 @lg:grid-cols-5">{children}</div>
    </section>
  );
}

// The full SMUI token set, light/dark aware (use the toolbar Theme toggle).
export const Palette: Story = {
  render: () => (
    <div className="@container flex flex-col gap-8">
      <Group label="base">
        <Swatch name="background" className="bg-background" />
        <Swatch name="card" className="bg-card" />
        <Swatch name="primary" className="bg-primary" />
        <Swatch name="secondary" className="bg-secondary" />
        <Swatch name="muted" className="bg-muted" />
        <Swatch name="accent" className="bg-accent" />
        <Swatch name="destructive" className="bg-destructive" />
        <Swatch name="border" className="bg-border" />
      </Group>

      <Group label="frost">
        <Swatch name="smui-frost-1" className="bg-smui-frost-1" />
        <Swatch name="smui-frost-2" className="bg-smui-frost-2" />
        <Swatch name="smui-frost-3" className="bg-smui-frost-3" />
        <Swatch name="smui-frost-4" className="bg-smui-frost-4" />
      </Group>

      <Group label="aurora">
        <Swatch name="smui-green" className="bg-smui-green" />
        <Swatch name="smui-yellow" className="bg-smui-yellow" />
        <Swatch name="smui-orange" className="bg-smui-orange" />
        <Swatch name="smui-red" className="bg-smui-red" />
        <Swatch name="smui-purple" className="bg-smui-purple" />
      </Group>

      <Group label="surfaces">
        <Swatch name="smui-surface-0" className="bg-smui-surface-0" />
        <Swatch name="smui-surface-1" className="bg-smui-surface-1" />
        <Swatch name="smui-surface-2" className="bg-smui-surface-2" />
        <Swatch name="smui-surface-3" className="bg-smui-surface-3" />
      </Group>
    </div>
  ),
};
