import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { buildQuotedComposerText } from "@/components/assistant-ui/quote";
import type { Anchor } from "@/components/assistant-ui/quote-selection-placement";
import {
  QuoteSelectionToolbar,
  SelectionToolbar,
} from "@/components/assistant-ui/quote-selection-toolbar";
import {
  clearTranscriptHighlight,
  paintTranscriptHighlight,
} from "@/components/assistant-ui/transcript-selection";

/**
 * The selection toolbar: highlight text inside a message (any element carrying
 * `data-message-id`) and a floating Copy / Quote / Tangent bar appears at the end of the
 * selection. The selection may span several transcript items - a shift-extended cross-item
 * range is captured, not rejected. Copy and Quote act on a snapshot taken the moment the
 * selection completes, so they keep working after the browser collapses the highlight (which
 * it does on every transcript re-render). The bar also clamps inside the viewport so it is
 * never clipped at an edge.
 *
 * `SelectToQuote` is the live, interactive surface (drag across the text). `PersistedHighlight`
 * shows the Trevor-owned highlight (CSS Custom Highlight API) rendered across two items with
 * NO live native selection - the state the plan keeps visible. The remaining stories drive the
 * presentational `SelectionToolbar` directly at fixed anchors so the edge-clamp,
 * stale-selection, and clipboard-failure states are reviewable without a real drag.
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
    const [tangent, setTangent] = useState<string | null>(null);
    return (
      <div className="flex max-w-2xl flex-col gap-4">
        <QuoteSelectionToolbar
          onQuote={(selected) => setDraft((prev) => buildQuotedComposerText(prev, selected).value)}
          onTangent={(selection) =>
            setTangent(`tangent from ${selection.sourceMessageId}: “${selection.text}”`)
          }
        />
        <div
          data-message-id="msg-1"
          className="flex flex-col gap-2 border-l-2 border-primary bg-card px-3 py-2 text-sm"
        >
          The blob store is content-addressed: bytes are named by their sha256, so a stored blob is
          immutable and identical content is stored exactly once. Highlight any part of this
          sentence and click Quote - or Tangent to branch a side conversation from it.
        </div>
        <div data-message-id="msg-2" className="flex flex-col gap-3 pl-3.5 text-sm">
          A second message. Shift-extend a selection from the message above into this one: the
          cross-item range is captured for Copy/Quote, but Tangent needs one source message so it
          dims for a cross-item span.
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
        {tangent ? (
          <p className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs text-foreground">
            {tangent}
          </p>
        ) : null}
      </div>
    );
  },
};

/**
 * The persisted cross-item highlight with NO live native selection. On mount it paints the
 * Trevor-owned highlight (`::highlight(trevor-transcript-selection)`) across a range that
 * starts mid-first-item and ends mid-second-item, then leaves it - exactly the state after the
 * browser collapses the native selection on a transcript re-render. The highlight should stay
 * visible (matching the native selection color) without any text being natively selected.
 * Requires the CSS Custom Highlight API (any current Chromium/Safari/Firefox).
 */
export const PersistedHighlight: Story = {
  render: () => {
    useEffect(() => {
      paintTranscriptHighlight({
        start: { segmentId: "persist-1", offset: 23 },
        end: { segmentId: "persist-2", offset: 28 },
      });
      return () => clearTranscriptHighlight();
    }, []);
    return (
      <div className="flex max-w-2xl flex-col gap-4 text-sm">
        <p className="text-xs text-muted-foreground">
          No text is natively selected, yet the highlight below persists across both items - this is
          the collapsed-native-selection state the plan keeps visible.
        </p>
        <div
          data-message-id="persist-1"
          className="flex flex-col gap-2 border-l-2 border-primary bg-card px-3 py-2"
        >
          Blobs are content-addressed by sha256, so identical content is stored exactly once and a
          stored blob is immutable.
        </div>
        <div data-message-id="persist-2" className="flex flex-col gap-3 pl-3.5">
          The session log is the source of truth; everything else is a projection rebuilt from it on
          demand.
        </div>
      </div>
    );
  },
};

/**
 * Renders the presentational toolbar at a fixed `anchor`, with a marker dot at that anchor
 * and a caption, so a reviewer can see where the selection ended vs where the (clamped)
 * toolbar landed.
 */
const Placement = ({
  anchor,
  copyFailed = false,
  tangentEnabled = false,
  caption,
}: {
  anchor: Anchor;
  copyFailed?: boolean;
  /** Whether the Tangent action is live (single-message selection) vs dimmed (cross-item / unwired). */
  tangentEnabled?: boolean;
  caption: string;
}) => (
  <div className="relative h-72 w-full text-xs text-muted-foreground">
    <p className="max-w-md">{caption}</p>
    <span
      className="bg-primary rounded-full"
      style={{
        position: "fixed",
        top: anchor.y - 3,
        left: anchor.x - 3,
        height: 6,
        width: 6,
        zIndex: 60,
      }}
      aria-hidden="true"
    />
    <SelectionToolbar
      anchor={anchor}
      copyFailed={copyFailed}
      onCopy={() => {}}
      onQuote={() => {}}
      onTangent={tangentEnabled ? () => {} : null}
    />
  </div>
);

export const Centered: Story = {
  render: () => (
    <Placement
      anchor={{ x: window.innerWidth / 2, y: 220 }}
      caption="Centered: with room on every side the toolbar sits centered above the anchor dot."
    />
  ),
};

export const LeftEdge: Story = {
  render: () => (
    <Placement
      anchor={{ x: 8, y: 220 }}
      caption="Left edge: the anchor is at x=8, but the toolbar slides inward so Copy stays reachable instead of being clipped off-screen."
    />
  ),
};

export const RightEdge: Story = {
  render: () => (
    <Placement
      anchor={{ x: window.innerWidth - 8, y: 220 }}
      caption="Right edge: the anchor is hard against the right side; the toolbar clamps so Tangent does not spill past the viewport."
    />
  ),
};

export const TopEdgeFlipsBelow: Story = {
  render: () => (
    <Placement
      anchor={{ x: window.innerWidth / 2, y: 12 }}
      caption="Top edge: with no room above, the toolbar flips below the anchor dot instead of clipping past the top."
    />
  ),
};

export const StaleSelection: Story = {
  render: () => (
    <Placement
      anchor={{ x: window.innerWidth / 2, y: 220 }}
      caption="Stale native selection: there is no live browser selection here at all, yet the toolbar still renders and its Copy/Quote act on the captured snapshot. This is the failure the plan fixes - the highlight can vanish on re-render and the actions still work."
    />
  ),
};

export const ClipboardFailure: Story = {
  render: () => (
    <Placement
      anchor={{ x: window.innerWidth / 2, y: 220 }}
      copyFailed
      caption="Clipboard failure: when navigator.clipboard rejects (permissions/focus) the toolbar stays open in a red Retry state with the snapshot still available, rather than silently dropping the copy."
    />
  ),
};

export const TangentEnabled: Story = {
  render: () => (
    <Placement
      anchor={{ x: window.innerWidth / 2, y: 220 }}
      tangentEnabled
      caption="Tangent enabled (plan 37): the selection sits inside ONE message, so Tangent lights up beside Copy and Quote. Clicking it seeds a branched side conversation from the snapshot + its source message."
    />
  ),
};

export const TangentDisabledCrossItem: Story = {
  render: () => (
    <Placement
      anchor={{ x: window.innerWidth / 2, y: 220 }}
      caption="Tangent disabled: the selection spans two messages (or nothing is wired), so Copy and Quote still act on the whole span but Tangent dims - a tangent needs a single source message."
    />
  ),
};
