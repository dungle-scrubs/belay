import {
  AssistantRuntimeProvider,
  SimpleImageAttachmentAdapter,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { QuoteSelectionToolbar } from "@/components/assistant-ui/quote-selection-toolbar";
import { Thread } from "@/components/assistant-ui/thread";

const SAMPLE: ThreadMessageLike[] = [
  { role: "user", content: "create a sample plan using lucid" },
  {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        text: "Keep it short: a numbered list, one fenced code block, and a single link.",
      },
      {
        type: "tool-call",
        toolCallId: "call_read_1",
        toolName: "read",
        args: { path: "apps/web/src/App.tsx" },
        result: "// 659 lines of React",
      },
      {
        type: "text",
        text: [
          "Here's a sample plan:",
          "",
          "1. **Scaffold** the design system in `apps/web`",
          "2. Build the composer + chat messages",
          "3. Verify everything in Storybook",
          "",
          "```ts",
          'const plan = ["scaffold", "build", "verify"] as const;',
          "```",
          "",
          "See [the SMUI guide](https://smui.statico.io) for the aesthetic.",
        ].join("\n"),
      },
    ],
  },
];

// Bridges static sample messages into assistant-ui via the external-store
// runtime. A real app swaps this for a Richter-backed runtime adapter.
function MockThread({
  initial = SAMPLE,
  isRunning = false,
}: {
  initial?: ThreadMessageLike[];
  isRunning?: boolean;
}) {
  const [messages, setMessages] = useState<ThreadMessageLike[]>(initial);
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning,
    convertMessage: (message: ThreadMessageLike) => message,
    // Enables image attachments + thumbnails in the composer. A real app would
    // use an adapter that uploads to the host instead.
    adapters: { attachments: new SimpleImageAttachmentAdapter() },
    onNew: async (message) => {
      setMessages((prev) => [
        ...prev,
        { role: "user", content: message.content },
        {
          role: "assistant",
          content: "Mock runtime - wire a Richter-backed runtime for real replies.",
        },
      ]);
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="mx-auto h-[36rem] w-full max-w-3xl border border-border">
        <Thread />
      </div>
      {/* Drag-highlight any message text to reveal the "Quote" toolbar. */}
      <QuoteSelectionToolbar />
    </AssistantRuntimeProvider>
  );
}

const meta = {
  title: "Components/PromptInput",
  component: MockThread,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof MockThread>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Empty: Story = {
  render: () => <MockThread initial={[]} />,
};

// Demonstrates the quote-on-selection toolbar. Highlight any message text to
// reveal the "Quote" / "Tangent" popup.
export const QuoteFromSelection: Story = {
  name: "Quote from selection",
  render: () => (
    <div className="flex h-full flex-col">
      <p className="text-muted-foreground mx-auto w-full max-w-3xl px-4 pt-4 text-sm">
        Drag-highlight any text in a message below to reveal the Quote / Tangent toolbar.
      </p>
      <MockThread />
    </div>
  ),
};
