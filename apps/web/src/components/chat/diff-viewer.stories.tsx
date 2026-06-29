import type { Meta, StoryObj } from "@storybook/react-vite";
import { DiffViewer } from "@/components/assistant-ui/diff-viewer";
import { storyFrame } from "@/components/chat/story-frame";
import { ToolCall } from "./message";

const meta = {
  title: "Chat/DiffViewer",
  component: DiffViewer,
  parameters: { layout: "padded" },
} satisfies Meta<typeof DiffViewer>;

export default meta;

type Story = StoryObj<typeof meta>;

const OLD = `export function greet(name) {
  const greeting = "hi " + name;
  return greeting;
}`;

const NEW = `export function greet(name: string) {
  const greeting = \`hello, \${name}\`;
  return greeting.trim();
}`;

const WRITTEN = `import { cn } from "@/lib/utils";

export function Spacer({ size = 4 }: { size?: number }) {
  return <div className={cn("w-full")} style={{ height: size * 4 }} />;
}`;

const Frame = storyFrame("w-[64rem]");

// The edit tool: old_string -> new_string.
export const Edit: Story = {
  render: () => (
    <Frame>
      <DiffViewer
        oldFile={{ content: OLD, name: "apps/web/src/greet.ts" }}
        newFile={{ content: NEW, name: "apps/web/src/greet.ts" }}
      />
    </Frame>
  ),
};

// The write tool: a brand-new file (empty old side -> all additions).
export const Write: Story = {
  render: () => (
    <Frame>
      <DiffViewer
        oldFile={{ content: "", name: "apps/web/src/components/spacer.tsx" }}
        newFile={{ content: WRITTEN, name: "apps/web/src/components/spacer.tsx" }}
      />
    </Frame>
  ),
};

export const SplitView: Story = {
  render: () => (
    <Frame>
      <DiffViewer
        viewMode="split"
        oldFile={{ content: OLD, name: "apps/web/src/greet.ts" }}
        newFile={{ content: NEW, name: "apps/web/src/greet.ts" }}
      />
    </Frame>
  ),
};

// Composed inside the generic ToolCall, as it renders in a transcript.
export const InToolCall: Story = {
  render: () => (
    <Frame>
      <ToolCall name="edit" args="apps/web/src/greet.ts" status="done">
        <DiffViewer
          oldFile={{ content: OLD, name: "apps/web/src/greet.ts" }}
          newFile={{ content: NEW, name: "apps/web/src/greet.ts" }}
        />
      </ToolCall>
    </Frame>
  ),
};
