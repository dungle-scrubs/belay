import type { Meta, StoryObj } from "@storybook/react-vite";

const meta: Meta = {
  title: "Foundations/Typography",
  parameters: { layout: "fullscreen" },
};

export default meta;

type Story = StoryObj;

function Row({ util, size, children }: { util: string; size: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-4 border-b border-border py-2 last:border-b-0">
      <code className="text-label text-muted-foreground tracking-wider w-28 shrink-0">{util}</code>
      <span className="text-label text-muted-foreground w-12 shrink-0">{size}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}

// JetBrains Mono only. The custom text-label/ui/heading/stat/hero sizes come
// from the @theme block; text-xs/text-sm are stock Tailwind.
export const Scale: Story = {
  render: () => (
    <div className="flex flex-col">
      <Row util="text-label" size="11px">
        <span className="text-label uppercase tracking-wider">label / badge text</span>
      </Row>
      <Row util="text-ui" size="13px">
        <span className="text-ui">ui text - buttons, nav, table body</span>
      </Row>
      <Row util="text-xs" size="12px">
        <span className="text-xs">card titles and small text</span>
      </Row>
      <Row util="text-sm" size="14px">
        <span className="text-sm">body text and list items</span>
      </Row>
      <Row util="text-heading" size="22px">
        <span className="text-heading tracking-tight">section heading</span>
      </Row>
      <Row util="text-stat" size="26px">
        <span className="text-stat font-medium tracking-tight">1,247,830</span>
      </Row>
      <Row util="text-hero" size="42px">
        <span className="text-hero tracking-tight">spacemolt</span>
      </Row>
    </div>
  ),
};

// The recurring class combinations from the SMUI aesthetic guide.
export const Patterns: Story = {
  render: () => (
    <div className="flex flex-col gap-5">
      <div className="text-xs text-muted-foreground tracking-[1.5px] uppercase font-normal">
        card title
      </div>
      <div className="text-label text-muted-foreground tracking-[1.5px] uppercase">field label</div>
      <div className="text-label text-muted-foreground tracking-wider">status / role text</div>
      <div className="text-stat font-medium text-foreground tracking-tight">142 / 7</div>
      <div className="text-xs text-muted-foreground tracking-[2px] uppercase">section eyebrow</div>
      <div className="text-heading font-medium text-foreground tracking-tight">section heading</div>
      <p className="text-sm text-muted-foreground">
        Body text uses muted-foreground for secondary reading on dark surfaces.
      </p>
    </div>
  ),
};
