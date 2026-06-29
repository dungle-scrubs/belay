import type { Meta, StoryObj } from "@storybook/react-vite";
import { TranscriptRowView } from "@/components/chat/transcript-row-view";
import type { AssistantMessage, Message } from "../../transcript";
import type { TranscriptRow } from "../../transcript-rows";

/**
 * Step-backstop auto-continue (02.17): the visual difference between the QUIET checkpoint breadcrumb
 * (the loop reached the adaptive step budget with room + progress and continued) and the alarming
 * `step_backstop` PAUSE card (a genuine terminating stop at the emergency ceiling or a failed progress
 * guard). The breadcrumb must read as understated background activity; the pause card as a real halt.
 */
const meta: Meta<typeof TranscriptRowView> = {
  title: "Chat/CheckpointBreadcrumb",
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

const pausedAssistant: AssistantMessage = {
  kind: "assistant",
  id: "a1",
  runId: "r1",
  text: "",
  thinking: "",
  done: true,
  warm: true,
  model: "minimax-m3",
  stop: {
    cause: "step_backstop",
    action: "paused",
    summary: "Paused at the 256-step emergency ceiling (runaway guard).",
  },
};

export const BreadcrumbVsPause: Story = {
  render: () => (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">
          Quiet checkpoint breadcrumb (auto-continue):
        </span>
        <TranscriptRowView
          row={messageRow({
            kind: "continued",
            id: "cont1",
            steps: 64,
            pressure: 0.207,
            detail: "continued at step 64 - 20.7% context, room left",
          })}
          showThinking={false}
          onOpenPath={noop}
          onDoctorRefresh={noop}
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">
          Genuine step_backstop pause card (terminating stop):
        </span>
        <TranscriptRowView
          row={messageRow(pausedAssistant)}
          showThinking={false}
          onOpenPath={noop}
          onDoctorRefresh={noop}
        />
      </div>
    </div>
  ),
};
