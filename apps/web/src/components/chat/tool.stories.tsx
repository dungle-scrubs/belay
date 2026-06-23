import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToolCall } from "./message";
import { MultiEditDiff } from "./multi-edit-diff";
import { ToolDiff } from "./tool-diff";

// One story per host tool. read/bash/glob/grep/skill render as the generic
// ToolCall row; write/edit render as code diffs (ToolDiff).
const meta: Meta = {
  title: "Chat/Tools",
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj;

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div className="w-[48rem] max-w-full">{children}</div>
);

const EDIT_OLD = `import { trim } from "./util";

export function greet(name) {
  const greeting = "hi " + name;
  return greeting;
}

export const DEFAULT_NAME = "world";`;

const EDIT_NEW = `import { trim } from "./util";

export function greet(name: string) {
  const greeting = \`hello, \${name}\`;
  return trim(greeting);
}

export const DEFAULT_NAME = "world";`;

const WRITTEN = `import { cn } from "@/lib/utils";

export function Spacer({ size = 4 }: { size?: number }) {
  return <div className={cn("w-full")} style={{ height: size * 4 }} />;
}`;

export const Read: Story = {
  render: () => (
    <Frame>
      <ToolCall name="read" args="apps/web/src/App.tsx" status="done" />
    </Frame>
  ),
};

export const Bash: Story = {
  render: () => (
    <Frame>
      <ToolCall name="bash" args="pnpm --filter @trevor/web typecheck" status="done">
        <pre className="whitespace-pre-wrap">$ tsgo --noEmit -p tsconfig.json{"\n"}(no errors)</pre>
      </ToolCall>
    </Frame>
  ),
};

export const Glob: Story = {
  render: () => (
    <Frame>
      <ToolCall name="glob" args="apps/web/src/**/*.tsx" status="done" />
    </Frame>
  ),
};

export const Grep: Story = {
  render: () => (
    <Frame>
      <ToolCall name="grep" args="useRichterSession" status="done">
        3 matches in 2 files
      </ToolCall>
    </Frame>
  ),
};

export const Skill: Story = {
  render: () => (
    <Frame>
      <ToolCall name="skill" args="tdd" status="done" />
    </Frame>
  ),
};

// write: a brand-new file (all additions).
export const Write: Story = {
  render: () => (
    <Frame>
      <ToolDiff tool="write" path="apps/web/src/components/spacer.tsx" newText={WRITTEN} />
    </Frame>
  ),
};

// edit: in-place replacement, with up to 3 lines of subdued context.
export const Edit: Story = {
  render: () => (
    <Frame>
      <ToolDiff tool="edit" path="apps/web/src/greet.ts" oldText={EDIT_OLD} newText={EDIT_NEW} />
    </Frame>
  ),
};

// multi_edit, several edits to a single file (one atomic operation).
export const MultiEditSameFile: Story = {
  render: () => (
    <Frame>
      <MultiEditDiff
        edits={[
          {
            path: "apps/web/src/greet.ts",
            old: "export function greet(name) {",
            new: "export function greet(name: string) {",
          },
          {
            path: "apps/web/src/greet.ts",
            old: '  const greeting = "hi " + name;',
            new: "  const greeting = `hello, ${name}`;",
          },
        ]}
      />
    </Frame>
  ),
};

// multi_edit across several files, each a collapsible section.
export const MultiEditMultiFile: Story = {
  render: () => (
    <Frame>
      <MultiEditDiff
        edits={[
          {
            path: "apps/web/src/greet.ts",
            old: 'const DEFAULT = "world";',
            new: 'const DEFAULT = "friend";',
          },
          {
            path: "apps/web/src/router.ts",
            old: 'register("/old", handler);',
            new: 'register("/new", handler);',
          },
          {
            path: "apps/web/src/types.ts",
            old: "export type Id = number;",
            new: "export type Id = string;",
          },
        ]}
      />
    </Frame>
  ),
};
