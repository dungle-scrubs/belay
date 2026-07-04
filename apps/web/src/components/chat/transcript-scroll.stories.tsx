import type { Meta, StoryObj } from "@storybook/react-vite";

/**
 * The transcript scroll-layout model (D-086), as a presentational fixture: a normal top-down column
 * inside a fixed-height frame, with the composer pinned below. It demonstrates that a short session
 * sits at the TOP padding and grows downward (instead of bottom-aligning above the composer), and
 * that an overflowing transcript scrolls. The real wiring + live-edge follow lives in app.tsx; this
 * is the visual catalog of the layout states the plan calls for.
 */

interface WellProps {
  /** Number of exchange rows to render (each = a user prompt + an assistant reply). */
  rows: number;
  /** Frame height, to check both mobile and desktop viewports. */
  heightClass?: string;
}

function TranscriptWellFixture({ rows, heightClass = "h-[40rem]" }: WellProps) {
  return (
    <div
      className={`flex w-full max-w-2xl flex-col border border-border bg-smui-surface-sunken px-4 ${heightClass}`}
    >
      {/* The transcript well: normal top-down column (matches app.tsx) - content starts at the top
        padding and appends downward; once it overflows the frame it scrolls. `data-transcript-scroll`
        applies the themed native scrollbar (index.css, plan 33), so the overflow stories show the real bar. */}
      <div data-transcript-scroll className="flex flex-1 flex-col gap-8 overflow-y-auto py-4">
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static fixture rows.
          <div key={i} className="flex flex-col gap-3">
            <div className="border-l-2 border-primary bg-card px-3 py-2 text-foreground text-sm">
              prompt #{i + 1}: walk me through the turn scheduler
            </div>
            <div className="pl-3.5 text-foreground text-sm">
              The scheduler runs one turn at a time behind a deferred FIFO, folds older turns when
              over budget, and admits a deferred mid-turn prompt only when it drains.
            </div>
          </div>
        ))}
      </div>
      {/* The composer/footer stays pinned below the scroll area on every viewport. */}
      <div className="shrink-0 pt-2 pb-4">
        <div className="flex flex-col border border-input bg-background">
          <div className="px-3 pt-2.5 pb-6 text-muted-foreground/50 text-sm">message qwen…</div>
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Chat/TranscriptScroll",
  component: TranscriptWellFixture,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TranscriptWellFixture>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Empty replayed session: an empty well, no fake spacer, composer pinned below. */
export const Empty: Story = { args: { rows: 0 } };

/** A single submitted message sits at the top padding, not bottom-aligned above the composer. */
export const OneMessage: Story = { name: "One message", args: { rows: 1 } };

/** A short exchange appends downward from the top. */
export const ShortExchange: Story = { name: "Short exchange", args: { rows: 2 } };

/** Just before overflow: content nearly fills the frame, still top-anchored. */
export const JustBeforeOverflow: Story = { name: "Just before overflow", args: { rows: 4 } };

/** Overflowing: content exceeds the frame and the well scrolls (live-edge follow is in App). */
export const Overflowing: Story = { args: { rows: 12 } };

/** Mobile height: the composer stays pinned and early content does not overlap it. */
export const MobileHeight: Story = {
  name: "Mobile height",
  args: { rows: 1, heightClass: "h-[24rem]" },
};

/** Desktop height: a tall frame, short content still top-anchored. */
export const DesktopHeight: Story = {
  name: "Desktop height",
  args: { rows: 1, heightClass: "h-[48rem]" },
};
