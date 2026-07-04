import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SessionSummary } from "@trevor/session";
import { sessionSummary } from "@trevor/test-kit";
import type { ReactNode } from "react";
import { TangentDiscovery } from "./tangent-discovery";

/**
 * Parent tangent discovery (plan 37, M7): a takeover listing the current session's tangents - source
 * snippet, status, recency, open action - kept separate from the ordinary sidebar/resume. Framed in a
 * fixed-size panel like the other takeover surfaces.
 */
const noop = () => {};
const NOW = Date.parse("2026-07-04T12:00:00.000Z");

function tangent(id: string, quote: string, updatedAt: string, over: Partial<SessionSummary> = {}) {
  return sessionSummary({
    sessionId: id,
    updatedAt,
    tangentOf: {
      parentSessionId: "parent",
      sourceMessageId: "e2",
      quote,
      label: null,
      createdAt: updatedAt,
    },
    ...over,
  });
}

const ROWS: SessionSummary[] = [
  tangent("t1", "blobs are content-addressed by their sha256", "2026-07-04T11:45:00.000Z", {
    activity: "running",
    host: "live",
  }),
  tangent(
    "t2",
    "the session log is the source of truth; everything else is a projection rebuilt from it",
    "2026-07-04T09:00:00.000Z",
  ),
];

function Panel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{ width: 560, height: 620, flexShrink: 0 }}
      className="overflow-hidden rounded-lg border border-border"
    >
      {children}
    </div>
  );
}

const meta: Meta<typeof TangentDiscovery> = {
  title: "Tangent/TangentDiscovery",
  component: TangentDiscovery,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof TangentDiscovery>;

export const List: Story = {
  render: () => (
    <Panel>
      <TangentDiscovery
        className="h-full"
        tangents={ROWS}
        nowMs={NOW}
        onOpen={noop}
        onBack={noop}
      />
    </Panel>
  ),
};

export const Empty: Story = {
  render: () => (
    <Panel>
      <TangentDiscovery className="h-full" tangents={[]} nowMs={NOW} onOpen={noop} onBack={noop} />
    </Panel>
  ),
};
