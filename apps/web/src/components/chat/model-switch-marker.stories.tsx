import type { Meta, StoryObj } from "@storybook/react-vite";
import { TranscriptRowView } from "@/components/chat/transcript-row-view";
import type { Message, ModelSwitchMessage } from "../../transcript";
import type { TranscriptRow } from "../../transcript-rows";

/**
 * Plan 09.1 M3: the mid-turn model/reasoning switch breadcrumb. A quiet inline marker (sibling to the
 * checkpoint breadcrumb) that renders the from->to delta: reasoning-only (same model), model-only, both,
 * and a blocked larger->smaller switch that shows the guard's reason instead of a delta. It must read as
 * understated background activity, never an alarming card.
 */
const meta: Meta<typeof TranscriptRowView> = {
  title: "Chat/ModelSwitchMarker",
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

const marker = (over: Partial<ModelSwitchMessage> & { id: string }): ModelSwitchMessage => ({
  kind: "modelSwitch",
  from: { model: "deepseek-v4", reasoning: "low" },
  to: { model: "deepseek-v4", reasoning: "high" },
  initiator: "manual",
  outcome: "applied",
  ...over,
});

const Row = ({ message }: { message: ModelSwitchMessage }) => (
  <TranscriptRowView
    row={messageRow(message)}
    showThinking={false}
    onOpenPath={noop}
    onDoctorRefresh={noop}
  />
);

export const ReasoningOnly: Story = {
  render: () => <Row message={marker({ id: "r" })} />,
};

export const ModelOnly: Story = {
  render: () => (
    <Row
      message={marker({
        id: "m",
        from: { model: "deepseek-v4" },
        to: { model: "kimi-k2" },
      })}
    />
  ),
};

export const ModelAndReasoning: Story = {
  render: () => (
    <Row
      message={marker({
        id: "b",
        from: { model: "deepseek-v4", reasoning: "low" },
        to: { model: "kimi-k2", reasoning: "high" },
      })}
    />
  ),
};

export const Blocked: Story = {
  render: () => (
    <Row
      message={marker({
        id: "x",
        from: { model: "kimi-k2", reasoning: "high" },
        to: { model: "haiku-4-5", reasoning: "high" },
        outcome: "blocked",
        reason: "conversation does not fit the smaller context window",
      })}
    />
  ),
};

export const AllStates: Story = {
  render: () => (
    <div className="flex max-w-2xl flex-col gap-4">
      <Row message={marker({ id: "s1" })} />
      <Row message={marker({ id: "s2", from: { model: "deepseek-v4" }, to: { model: "kimi-k2" } })} />
      <Row
        message={marker({
          id: "s3",
          from: { model: "deepseek-v4", reasoning: "low" },
          to: { model: "kimi-k2", reasoning: "high" },
        })}
      />
      <Row
        message={marker({
          id: "s4",
          outcome: "blocked",
          to: { model: "haiku-4-5", reasoning: "high" },
          reason: "conversation does not fit the smaller context window",
        })}
      />
    </div>
  ),
};
