import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import type { ProviderQuestionAnswer } from "@trevor/session";
import { useState } from "react";
import * as fx from "./fixtures";
import { QuestionSurface } from "./QuestionSurface";

/**
 * The ask_user question surface, Storybook-first. Each story is a real pending-question contract from
 * the shared fixtures (./fixtures), so the stories and the view-model tests render the same payloads.
 *
 * Width is set PER STORY (not on meta): Storybook nests story decorators inside meta decorators, so a
 * meta-level width wrapper would cap a story that wants to be wider. The preview master-detail only
 * splits when the surface is wide enough (a container query), so the wide stories set a real width.
 */
const meta = {
  title: "Chat/QuestionSurface",
  component: QuestionSurface,
  parameters: { layout: "centered" },
  args: { onAnswer: () => {} },
} satisfies Meta<typeof QuestionSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Constrain a story to a fixed width so the surface's container queries have a real width to react to. */
const atWidth =
  (className: string): Decorator =>
  (Story) => (
    <div className={className}>
      <Story />
    </div>
  );

const DESKTOP = "w-[30rem] max-w-full";
const NARROW = "w-[20rem]";
const WIDE = "w-[52rem] max-w-full";

export const SingleChoice: Story = {
  args: { contract: fx.singleChoice },
  decorators: [atWidth(DESKTOP)],
};

export const MultiSelect: Story = {
  args: { contract: fx.multiSelect },
  decorators: [atWidth(DESKTOP)],
};

export const FreeText: Story = { args: { contract: fx.freeText }, decorators: [atWidth(DESKTOP)] };

export const RequiredReason: Story = {
  args: { contract: fx.requiredReason },
  decorators: [atWidth(DESKTOP)],
};

export const Deferrable: Story = {
  args: { contract: fx.deferrable },
  decorators: [atWidth(DESKTOP)],
};

export const Grouped: Story = { args: { contract: fx.grouped }, decorators: [atWidth(DESKTOP)] };

/**
 * Visualization choices on a WIDE surface: the options list on the left and the highlighted option's
 * ASCII preview shows on the right, one at a time. Arrow/Tab/hover through the list and the right pane
 * tracks the highlight. This is the two-column master-detail.
 */
export const WithPreviews: Story = {
  args: { contract: fx.withPreviews },
  decorators: [atWidth(WIDE)],
};

/** The same previews on a narrow side-panel/mobile width: the split collapses to inline previews. */
export const PreviewsNarrow: Story = {
  args: { contract: fx.withPreviews },
  decorators: [atWidth(NARROW)],
};

/** The run ended before the user answered: read-only, every control disabled (AQ003). */
export const Expired: Story = {
  args: { contract: fx.singleChoice, expired: true },
  decorators: [atWidth(DESKTOP)],
};

/** Narrow side-panel width with a multi-question group - the layout must not overflow. */
export const NarrowGrouped: Story = {
  args: { contract: fx.grouped },
  decorators: [atWidth(NARROW)],
};

/** Long labels and descriptions wrap cleanly instead of pushing the card wide. */
export const LongLabels: Story = {
  args: {
    contract: fx.contract([
      fx.question({
        id: "long",
        question:
          "Which extremely-verbose strategy should the background reconciliation worker adopt when it encounters a partially-applied migration during startup?",
        answerShape: "single_choice",
        choices: [
          fx.choice({
            id: "rollback",
            label: "Roll the whole batch back and re-run it from the last known-good checkpoint",
            description:
              "Safest, but it discards any partial progress and can take a long time on a large backlog of pending rows.",
            recommended: true,
          }),
          fx.choice({
            id: "resume",
            label: "Resume from the first unapplied statement and trust the idempotency guards",
            risk: "Depends on every statement being genuinely idempotent, which has not been audited end to end.",
          }),
        ],
      }),
    ]),
  },
  decorators: [atWidth("w-[22rem]")],
};

/** Interactive: pick an answer and submit to see the emitted wire payload. */
export const Interactive: Story = {
  render: (args) => {
    const [last, setLast] = useState<ProviderQuestionAnswer | null>(null);
    return (
      <div className="flex flex-col gap-3">
        <QuestionSurface {...args} onAnswer={setLast} />
        <pre className="max-h-48 overflow-auto rounded-md bg-smui-surface-sunken p-3 text-[11px] text-muted-foreground">
          {last ? JSON.stringify(last, null, 2) : "// submit an answer to see the payload"}
        </pre>
      </div>
    );
  },
  args: { contract: fx.withPreviews },
  decorators: [atWidth(WIDE)],
};
