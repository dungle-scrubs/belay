import type { Meta, StoryObj } from "@storybook/react-vite";
import { TranscriptRowView } from "@/components/chat/transcript-row-view";
import type { LimitMessage, Message } from "../../transcript";
import type { TranscriptRow } from "../../transcript-rows";

/**
 * Plan 44.4: the provider usage-limit marker, folded from `assistant.limit`. `approaching` is a quiet
 * muted breadcrumb (sibling to the model-switch marker) - understated background activity; `reached` is
 * the louder yellow alert (like `recovered`) because the window is actually exhausted. Detection only:
 * neither offers an action. Fixtures omit `resetsAt` so the visual baseline is clock-independent (the
 * humanized "resets in X" is exercised by the `limitMarkerSummary` unit test instead).
 */
const meta: Meta<typeof TranscriptRowView> = {
  title: "Chat/UsageLimitMarker",
  component: TranscriptRowView,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof TranscriptRowView>;

const noop = () => {};

const messageRow = (message: Message): TranscriptRow =>
  ({
    kind: "message",
    id: `message:${"id" in message ? message.id : "x"}`,
    compactAbove: false,
    message,
  }) as TranscriptRow;

const marker = (over: Partial<LimitMessage> & { id: string }): LimitMessage => ({
  kind: "limit",
  provider: "anthropic",
  status: "approaching",
  scope: "five_hour",
  ...over,
});

const Row = ({ message }: { message: LimitMessage }) => (
  <TranscriptRowView
    row={messageRow(message)}
    showThinking={false}
    onOpenPath={noop}
    onDoctorRefresh={noop}
  />
);

export const Approaching: Story = {
  render: () => <Row message={marker({ id: "a", utilization: 0.9 })} />,
};

export const ReachedFiveHour: Story = {
  render: () => <Row message={marker({ id: "r", status: "reached", scope: "five_hour" })} />,
};

export const ReachedCodexDetectOnly: Story = {
  render: () => (
    <Row message={marker({ id: "c", provider: "codex", status: "reached", scope: "unknown" })} />
  ),
};

export const AllStates: Story = {
  render: () => (
    <div className="flex max-w-2xl flex-col gap-4">
      <Row message={marker({ id: "s1", utilization: 0.85 })} />
      <Row
        message={marker({ id: "s2", status: "approaching", scope: "seven_day", utilization: 0.92 })}
      />
      <Row message={marker({ id: "s3", status: "reached", scope: "seven_day_opus" })} />
      <Row message={marker({ id: "s4", provider: "codex", status: "reached", scope: "unknown" })} />
    </div>
  ),
};
