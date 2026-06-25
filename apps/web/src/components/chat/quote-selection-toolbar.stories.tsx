import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { buildQuotedComposerText } from "@/components/assistant-ui/quote";
import { QuoteSelectionToolbar } from "@/components/assistant-ui/quote-selection-toolbar";

/**
 * The select-to-quote toolbar: highlight text inside a message (any element carrying
 * `data-message-id`) and a floating "Quote" button appears at the end of the selection.
 * Clicking it drops the selection into the composer as a markdown blockquote. Try it by
 * dragging across the message text below; the mock composer shows the resulting value.
 */
const meta: Meta<typeof QuoteSelectionToolbar> = {
  title: "Chat/QuoteSelectionToolbar",
  component: QuoteSelectionToolbar,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof QuoteSelectionToolbar>;

export const SelectToQuote: Story = {
  render: () => {
    const [draft, setDraft] = useState("");
    return (
      <div className="flex max-w-2xl flex-col gap-4">
        <QuoteSelectionToolbar
          onQuote={(selected) => setDraft((prev) => buildQuotedComposerText(prev, selected).value)}
        />
        <div
          data-message-id="msg-1"
          className="flex flex-col gap-2 border-l-2 border-primary bg-card px-3 py-2 text-sm"
        >
          The blob store is content-addressed: bytes are named by their sha256, so a stored blob is
          immutable and identical content is stored exactly once. Highlight any part of this
          sentence and click Quote.
        </div>
        <div data-message-id="msg-2" className="flex flex-col gap-3 pl-3.5 text-sm">
          A second message. Selecting text that spans two messages does NOT offer the toolbar - a
          quote is scoped to a single message.
        </div>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          composer (quoted text lands here)
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            className="rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground"
            placeholder="Quote a selection above…"
          />
        </label>
      </div>
    );
  },
};
