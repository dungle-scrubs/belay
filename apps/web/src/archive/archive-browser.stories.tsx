import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { ArchiveBrowser } from "./archive-browser";
import type { ArchivedSessionRow } from "./archive-rows";

/**
 * Plan 04: the archive browser, Storybook-first. Like the model chooser it takes over the
 * transcript + composer space while the sidebars stay visible, so the stories frame it in a fixed-size
 * panel using INLINE pixel dimensions (sized reliably under the global centering preview decorator).
 * States cover overview, empty, loading, error, narrow + both-sidebars layouts, long labels, many rows,
 * a protected (undeletable) row, an in-flight/error row, and the typed delete-confirmation. Fixtures are
 * production-shaped `ArchivedSessionRow` read models.
 */

const meta: Meta<typeof ArchiveBrowser> = {
  title: "Archive/ArchiveBrowser",
  component: ArchiveBrowser,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof ArchiveBrowser>;

// A fixed wall clock so the relative-time recency labels are deterministic across stories.
const NOW = Date.parse("2026-06-29T12:00:00.000Z");

function row(over: Partial<ArchivedSessionRow> & { sessionId: string }): ArchivedSessionRow {
  return {
    title: `Session ${over.sessionId}`,
    project: "trevor",
    cwd: "~/dev/trevor",
    updatedAt: "2026-06-29T09:00:00.000Z",
    eventCount: 42,
    protectedReason: null,
    ...over,
  };
}

const ROWS: readonly ArchivedSessionRow[] = [
  row({ sessionId: "a", title: "Refactor the turn loop", updatedAt: "2026-06-29T11:30:00.000Z" }),
  row({
    sessionId: "b",
    title: "Investigate flaky e2e",
    project: "opchain",
    cwd: "~/dev/opchain",
    eventCount: 7,
    updatedAt: "2026-06-28T18:00:00.000Z",
  }),
  row({
    sessionId: "c",
    title: "Draft the archive browser plan",
    eventCount: 318,
    updatedAt: "2026-06-25T08:00:00.000Z",
  }),
];

const noop = () => {};

/** A fixed-size panel frame (inline px dimensions) so the browser renders at a realistic takeover size
 *  under the centering preview decorator - independent of Tailwind arbitrary-width generation. */
function Panel({ children, width = 880 }: { children: ReactNode; width?: number }) {
  return (
    <div
      style={{ width, height: 660, flexShrink: 0 }}
      className="overflow-hidden rounded-lg border border-border"
    >
      {children}
    </div>
  );
}

export const Overview: Story = {
  render: () => (
    <Panel>
      <ArchiveBrowser
        rows={ROWS}
        nowMs={NOW}
        onUnarchive={noop}
        onDelete={noop}
        onBack={noop}
        className="h-full"
      />
    </Panel>
  ),
};

export const Empty: Story = {
  render: () => (
    <Panel>
      <ArchiveBrowser
        rows={[]}
        nowMs={NOW}
        onUnarchive={noop}
        onDelete={noop}
        onBack={noop}
        className="h-full"
      />
    </Panel>
  ),
};

export const Loading: Story = {
  render: () => (
    <Panel>
      <ArchiveBrowser
        rows={[]}
        loading
        nowMs={NOW}
        onUnarchive={noop}
        onDelete={noop}
        onBack={noop}
        className="h-full"
      />
    </Panel>
  ),
};

export const ErrorState: Story = {
  render: () => (
    <Panel>
      <ArchiveBrowser
        rows={[]}
        error="Could not load archived sessions - the session store is unreachable."
        nowMs={NOW}
        onUnarchive={noop}
        onDelete={noop}
        onBack={noop}
        className="h-full"
      />
    </Panel>
  ),
};

/** A protected row (a live host) - permanent delete is disabled with the reason as its tooltip. */
export const ProtectedRow: Story = {
  render: () => (
    <Panel>
      <ArchiveBrowser
        rows={[
          row({
            sessionId: "live",
            title: "Active session with a live host",
            protectedReason: "a host is live on this session",
          }),
          ...ROWS,
        ]}
        nowMs={NOW}
        onUnarchive={noop}
        onDelete={noop}
        onBack={noop}
        className="h-full"
      />
    </Panel>
  ),
};

/** The typed delete-confirmation open on the first row (seeded via defaultConfirmingId). */
export const DeleteConfirmation: Story = {
  render: () => (
    <Panel>
      <ArchiveBrowser
        rows={ROWS}
        nowMs={NOW}
        defaultConfirmingId="a"
        onUnarchive={noop}
        onDelete={noop}
        onBack={noop}
        className="h-full"
      />
    </Panel>
  ),
};

/** Row-scoped async feedback: one row deleting, another showing a backend error. */
export const RowActionFeedback: Story = {
  render: () => (
    <Panel>
      <ArchiveBrowser
        rows={ROWS}
        nowMs={NOW}
        actionState={{
          a: { kind: "deleting" },
          b: { kind: "error", message: "Delete failed - the store rejected the request." },
        }}
        onUnarchive={noop}
        onDelete={noop}
        onBack={noop}
        className="h-full"
      />
    </Panel>
  ),
};

/** Long titles and deep cwds stay on one truncated line; the actions never get pushed off-row. */
export const LongLabels: Story = {
  render: () => (
    <Panel width={720}>
      <ArchiveBrowser
        rows={[
          row({
            sessionId: "long",
            title:
              "Investigate the intermittent websocket reconnect storm that surfaces only under heavy parallel host load on the shared session store",
            cwd: "~/dev/trevor/apps/agent-host/src/very/deeply/nested/path/to/the/module",
            eventCount: 1284,
          }),
          ...ROWS,
        ]}
        nowMs={NOW}
        onUnarchive={noop}
        onDelete={noop}
        onBack={noop}
        className="h-full"
      />
    </Panel>
  ),
};

/** Many rows - the list scrolls within the takeover, header + back arrow stay pinned. */
export const ManyRows: Story = {
  render: () => (
    <Panel>
      <ArchiveBrowser
        rows={Array.from({ length: 30 }, (_, i) =>
          row({ sessionId: `s${i}`, title: `Archived session ${i + 1}` }),
        )}
        nowMs={NOW}
        onUnarchive={noop}
        onDelete={noop}
        onBack={noop}
        className="h-full"
      />
    </Panel>
  ),
};

/** The browser between mock left/right sidebars - the takeover replaces only the center column. */
export const BothSidebarsVisible: Story = {
  render: () => (
    <div
      style={{ width: 1160, height: 660, flexShrink: 0 }}
      className="flex overflow-hidden rounded-lg border border-border"
    >
      <div
        style={{ width: 224 }}
        className="shrink-0 border-r border-border bg-smui-surface-sunken p-3 text-label tracking-wider text-muted-foreground"
      >
        Left sidebar
      </div>
      <div className="min-w-0 flex-1">
        <ArchiveBrowser
          rows={ROWS}
          nowMs={NOW}
          onUnarchive={noop}
          onDelete={noop}
          onBack={noop}
          className="h-full"
        />
      </div>
      <div
        style={{ width: 256 }}
        className="shrink-0 border-l border-border bg-smui-surface-sunken p-3 text-label tracking-wider text-muted-foreground"
      >
        Right panel
      </div>
    </div>
  ),
};

/** A deliberately narrow space after wide sidebars - rows and actions stay legible. */
export const NarrowAfterSidebars: Story = {
  render: () => (
    <div
      style={{ width: 1040, height: 660, flexShrink: 0 }}
      className="flex overflow-hidden rounded-lg border border-border"
    >
      <div
        style={{ width: 320 }}
        className="shrink-0 border-r border-border bg-smui-surface-sunken"
      />
      <div className="min-w-0 flex-1">
        <ArchiveBrowser
          rows={ROWS}
          nowMs={NOW}
          defaultConfirmingId="a"
          onUnarchive={noop}
          onDelete={noop}
          onBack={noop}
          className="h-full"
        />
      </div>
    </div>
  ),
};
