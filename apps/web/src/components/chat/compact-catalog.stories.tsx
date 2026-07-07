import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef } from "react";
import { createScrollFollowController } from "@/scroll-follow";
import { readOnlyToolBatches } from "../../transcript";
import { buildTranscriptRows, type TranscriptRow } from "../../transcript-rows";
import { catalogActive, catalogTranscript } from "./compact-catalog-fixtures";
import { VirtualTranscript } from "./virtual-transcript";

/**
 * Plan 58: the transcript CATALOG - one exemplar of every transcript item type, rendered through the
 * real renderer, side by side, so the whole taxonomy reads on one screen. `Catalog` is the compact
 * (1-2 line) form showing the type-aware spacing (a read-only batch and same-name tools sit flush; a
 * type change opens one blank line), the resting/active states, and the drill-in affordances (the
 * chevron on detail-eligible rows, and the hover "Inspect" takeover on tool/shell rows). `Full` is the
 * same taxonomy in full (non-compact) render - a full mock transcript of every item type.
 */

const meta: Meta<typeof VirtualTranscript> = {
  title: "Chat/CompactCatalog",
  component: VirtualTranscript,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof VirtualTranscript>;

function rowsFor(transcript: ReturnType<typeof catalogTranscript>): readonly TranscriptRow[] {
  return buildTranscriptRows({ transcript, toolBatches: readOnlyToolBatches(transcript) });
}

const CATALOG_ROWS = rowsFor(catalogTranscript());
const ACTIVE_ROWS = rowsFor(catalogActive());

function Frame({
  rows,
  height,
  compact = true,
}: {
  rows: readonly TranscriptRow[];
  height: number;
  compact?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Unpinned from the start: the catalog shows the transcript top-anchored, not snapped to the edge.
  const controllerRef = useRef(createScrollFollowController({ initialPinned: false }));
  return (
    <div
      ref={scrollRef}
      style={{ width: 760, height, flexShrink: 0 }}
      className="overflow-auto rounded-lg border border-border bg-background px-4 py-3"
    >
      <VirtualTranscript
        rows={rows}
        scrollRef={scrollRef}
        controller={controllerRef.current}
        scrollToBottomRequest={0}
        rowConfig={{
          showThinking: true,
          compact,
          onOpenPath: () => {},
          onDoctorRefresh: () => {},
          // Wiring these lights up the drill-in affordances (Inspect on tool/shell, inline-agent detail).
          onOpenDetail: () => {},
          onOpenAgent: () => {},
        }}
      />
    </div>
  );
}

/** Every transcript item type in its compact form, in resting/settled states. */
export const Catalog: Story = {
  render: () => <Frame rows={CATALOG_ROWS} height={1320} />,
};

/** Every transcript item type in its FULL (non-compact) render - a full mock transcript of the taxonomy. */
export const Full: Story = {
  render: () => <Frame rows={CATALOG_ROWS} height={760} compact={false} />,
};

/** The running/streaming forms of the kinds with a resting-vs-active duality (tool, assistant, delegation). */
export const ActiveStates: Story = {
  render: () => <Frame rows={ACTIVE_ROWS} height={260} />,
};
