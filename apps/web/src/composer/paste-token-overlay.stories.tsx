import type { PastePayload } from "@belay/session";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { type ComposerDraft, removePasteAt, syncComposerDraft } from "./draft";
import { PasteTokenOverlay } from "./paste-token-overlay";

/**
 * 10-large-paste-placeholders M4: pasted-text-token composer states, Storybook-first. The overlay
 * highlights `[Pasted text #N +M lines]` tokens (purple, distinct from frost image tokens) over a
 * real textarea, with a hover/focus inspection popover (counts, capped preview, copy, remove).
 * Stories cover one token, multiple tokens, a long surrounding prompt, narrow + desktop widths, and
 * a mixed image/paste composer - reviewed before any live composer wiring.
 */

const meta: Meta<typeof PasteTokenOverlay> = {
  title: "Composer/PasteTokenOverlay",
  component: PasteTokenOverlay,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof PasteTokenOverlay>;

const LOG_PAYLOAD: PastePayload = {
  text: Array.from(
    { length: 32 },
    (_, i) => `2026-06-29T19:${10 + i}:04Z  request ${i} ok 200`,
  ).join("\n"),
};
const STACK_PAYLOAD: PastePayload = {
  text: 'Traceback (most recent call last):\n  File "app.py", line 42, in <module>\n    main()\n  File "app.py", line 30, in main\n    raise ValueError(\'boom\')\nValueError: boom',
};
const WIDE_PAYLOAD: PastePayload = { text: `const data = ${"x".repeat(1800)};` };

/** A controlled composer at a fixed width: edits reconcile the draft and remove drops a payload. */
function Demo({ initial, width }: { initial: ComposerDraft; width: string }) {
  const [draft, setDraft] = useState<ComposerDraft>(initial);
  return (
    <div className={width}>
      <div className="border border-border bg-card">
        <PasteTokenOverlay
          value={draft.text}
          pastes={draft.pastes}
          onChange={(value) => setDraft((prev) => syncComposerDraft(prev, value))}
          onRemove={(index) => setDraft((prev) => removePasteAt(prev, index))}
        />
      </div>
      <p className="mt-2 text-label tracking-wider text-muted-foreground">
        hover a token to inspect · copy · remove · editable
      </p>
    </div>
  );
}

export const OnePastedToken: Story = {
  render: () => (
    <Demo
      initial={{
        text: "here is the failing log [Pasted text #1 +32 lines] what went wrong?",
        imageRefs: [],
        pastes: [LOG_PAYLOAD],
      }}
      width="w-[40rem]"
    />
  ),
};

export const MultiplePastedTokens: Story = {
  render: () => (
    <Demo
      initial={{
        text: "compare the log [Pasted text #1 +32 lines] with the stack trace [Pasted text #2 +6 lines]",
        imageRefs: [],
        pastes: [LOG_PAYLOAD, STACK_PAYLOAD],
      }}
      width="w-[44rem]"
    />
  ),
};

export const LongSurroundingPrompt: Story = {
  render: () => (
    <Demo
      initial={{
        text: "Here is a much longer prompt that should wrap across several lines in the composer so we can verify the paste token [Pasted text #1 +32 lines] keeps tracking the text as it reflows, and the prose after it continues to read naturally without the payload flooding the field.",
        imageRefs: [],
        pastes: [LOG_PAYLOAD],
      }}
      width="w-[34rem]"
    />
  ),
};

export const NarrowMobileWidth: Story = {
  render: () => (
    <Demo
      initial={{
        text: "on a narrow composer [Pasted text #1 +6 lines] the chip still wraps cleanly",
        imageRefs: [],
        pastes: [STACK_PAYLOAD],
      }}
      width="w-[20rem]"
    />
  ),
};

export const WideSingleLinePayload: Story = {
  render: () => (
    <Demo
      initial={{
        text: "paste of one enormous line [Pasted text #1 +1 lines] collapses to a chip",
        imageRefs: [],
        pastes: [WIDE_PAYLOAD],
      }}
      width="w-[40rem]"
    />
  ),
};

export const MixedImageAndPasteTokens: Story = {
  render: () => (
    <Demo
      initial={{
        text: "see [Image #1] and the log [Pasted text #1 +32 lines] together",
        imageRefs: [
          {
            kind: "image",
            mimeType: "image/png",
            size: 24_000,
            hash: "a".repeat(64),
            name: "shot.png",
          },
        ],
        pastes: [LOG_PAYLOAD],
      }}
      width="w-[44rem]"
    />
  ),
};
