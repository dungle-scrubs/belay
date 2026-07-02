import type { Meta, StoryObj } from "@storybook/react-vite";
import { Maximize2, Plus, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { VIM_MODES, type VimMode } from "@/vim/mode";
import { VimModeIndicator } from "./vim-mode-indicator";

/**
 * Plan 06 (M2): the Vim mode indicator in the composer bottom row, Storybook-first. States cover
 * insert/normal/visual next to the `+` upload button, the shell-lane glyph variant, upload
 * disabled/uploading/error, vim disabled (no indicator), and a narrow composer - confirming the
 * indicator never wraps or reflows the row (all three labels are stable-width).
 */

const meta: Meta<typeof VimModeIndicator> = {
  title: "Chat/VimModeIndicator",
  component: VimModeIndicator,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof VimModeIndicator>;

/** A mock of the composer bottom row (prompt-input.tsx): the `+` upload (or shell glyph) + expand, then
 *  the Vim indicator - so placement + height stability are reviewable before the M6 wiring. */
function BottomRow({
  glyph = "plus",
  indicator,
  uploadDisabled = false,
  width = 520,
}: {
  glyph?: "plus" | "shell";
  indicator?: ReactNode;
  uploadDisabled?: boolean;
  width?: number;
}) {
  return (
    <div
      style={{ width, flexShrink: 0 }}
      className="overflow-hidden rounded-lg border border-border bg-background"
    >
      <div className="min-h-16 px-2 pt-2 text-sm text-muted-foreground">message Trevor…</div>
      <div className="flex items-center gap-2 px-2 pb-2">
        {glyph === "shell" ? (
          <span className="flex size-7 items-center justify-center text-smui-orange">
            <Terminal className="size-4" />
          </span>
        ) : (
          <Button variant="ghost" size="icon" className="size-7" disabled={uploadDisabled}>
            <Plus className="size-4" />
          </Button>
        )}
        <Button variant="ghost" size="icon" className="size-7">
          <Maximize2 className="size-4" />
        </Button>
        {indicator}
      </div>
    </div>
  );
}

export const AllModes: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {VIM_MODES.map((mode) => (
        <BottomRow key={mode} indicator={<VimModeIndicator mode={mode} />} />
      ))}
    </div>
  ),
};

export const Insert: Story = {
  render: () => <BottomRow indicator={<VimModeIndicator mode="insert" />} />,
};

export const Normal: Story = {
  render: () => <BottomRow indicator={<VimModeIndicator mode="normal" />} />,
};

export const Visual: Story = {
  render: () => <BottomRow indicator={<VimModeIndicator mode="visual" />} />,
};

/** Vim disabled: no indicator renders, the bottom row is unchanged. */
export const Disabled: Story = {
  render: () => <BottomRow />,
};

/** The shell lane swaps `+` for the terminal glyph; the indicator keeps its place. */
export const ShellLane: Story = {
  render: () => <BottomRow glyph="shell" indicator={<VimModeIndicator mode="normal" />} />,
};

export const UploadDisabled: Story = {
  render: () => <BottomRow uploadDisabled indicator={<VimModeIndicator mode="insert" />} />,
};

/** Narrow composer - the indicator stays one stable-width pill and never wraps the row. */
export const Narrow: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {(["insert", "normal", "visual"] as VimMode[]).map((mode) => (
        <BottomRow key={mode} width={300} indicator={<VimModeIndicator mode={mode} />} />
      ))}
    </div>
  ),
};
