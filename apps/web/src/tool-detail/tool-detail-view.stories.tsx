import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import type { ToolDetailModel } from "./detail-model";
import { ToolDetailView } from "./tool-detail-view";

/**
 * Plan 08 M2: the tool detail takeover shell, Storybook-first. Like the model chooser and archive
 * browser it takes over the transcript + composer space while the sidebars stay visible, so the stories
 * frame it in a fixed-size panel using INLINE pixel dimensions (sized reliably under the global
 * centering preview decorator). States cover open/completed, running, error, aborted, empty output,
 * a long-output scroll, an unknown/MCP tool, the shell lane, and a narrow width.
 */

const meta: Meta<typeof ToolDetailView> = {
  title: "ToolDetail/ToolDetailView",
  component: ToolDetailView,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof ToolDetailView>;

const noop = () => {};

function model(over: Partial<ToolDetailModel> = {}): ToolDetailModel {
  return {
    id: "c1",
    source: "tool",
    toolName: "bash",
    status: "done",
    aborted: false,
    args: '{\n  "command": "ls -la",\n  "cwd": "~/dev/trevorV2"\n}',
    output: "total 24\ndrwxr-xr-x  apps\ndrwxr-xr-x  packages\n-rw-r--r--  package.json",
    ...over,
  };
}

/** A fixed-size panel frame (inline px dimensions) so the view renders at a realistic takeover size
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

export const Completed: Story = {
  render: () => (
    <Panel>
      <ToolDetailView model={model()} onBack={noop} className="h-full" />
    </Panel>
  ),
};

export const Running: Story = {
  render: () => (
    <Panel>
      <ToolDetailView
        model={model({ status: "running", output: undefined })}
        onBack={noop}
        className="h-full"
      />
    </Panel>
  ),
};

export const ErrorResult: Story = {
  render: () => (
    <Panel>
      <ToolDetailView
        model={model({
          toolName: "read",
          args: '{"path":"missing.ts"}',
          status: "error",
          output: undefined,
          error: "ENOENT: no such file or directory, open 'missing.ts'",
        })}
        onBack={noop}
        className="h-full"
      />
    </Panel>
  ),
};

export const Aborted: Story = {
  render: () => (
    <Panel>
      <ToolDetailView
        model={model({
          status: "error",
          aborted: true,
          output: undefined,
          error: "aborted before completion",
        })}
        onBack={noop}
        className="h-full"
      />
    </Panel>
  ),
};

export const EmptyOutput: Story = {
  render: () => (
    <Panel>
      <ToolDetailView
        model={model({ toolName: "write", args: '{"path":"a.ts"}', output: undefined })}
        onBack={noop}
        className="h-full"
      />
    </Panel>
  ),
};

export const LongOutput: Story = {
  render: () => (
    <Panel>
      <ToolDetailView
        model={model({
          toolName: "grep",
          args: '{"pattern":"export","path":"apps/web/src"}',
          output: Array.from(
            { length: 80 },
            (_, i) => `apps/web/src/file-${i}.ts:${i}: export const x = ${i}`,
          ).join("\n"),
        })}
        onBack={noop}
        className="h-full"
      />
    </Panel>
  ),
};

export const UnknownTool: Story = {
  render: () => (
    <Panel>
      <ToolDetailView
        model={model({
          toolName: "mcp__github__create_issue",
          args: '{"repo":"trevorV2","title":"bug"}',
          output: '{"number":123,"url":"https://github.com/..."}',
        })}
        onBack={noop}
        className="h-full"
      />
    </Panel>
  ),
};

export const ShellLane: Story = {
  render: () => (
    <Panel>
      <ToolDetailView
        model={model({
          source: "shell",
          toolName: "shell",
          args: "pnpm test",
          output: "2199 passed",
        })}
        onBack={noop}
        className="h-full"
      />
    </Panel>
  ),
};

export const Narrow: Story = {
  render: () => (
    <Panel width={420}>
      <ToolDetailView model={model()} onBack={noop} className="h-full" />
    </Panel>
  ),
};

/** The detail takes over only the CENTER column - the left session rail and right side panel stay
 *  visible (mocked here as plain rails) - confirming it reads as a takeover, not a full-screen modal. */
export const BothSidebarsVisible: Story = {
  render: () => (
    <div
      style={{ flexShrink: 0 }}
      className="flex h-[660px] w-[1180px] overflow-hidden rounded-lg border border-border"
    >
      {/* Left session rail (mock placeholder). */}
      <div className="w-56 shrink-0 border-r border-border bg-smui-surface-sunken" />
      <div className="min-w-0 flex-1">
        <ToolDetailView model={model()} onBack={noop} className="h-full" />
      </div>
      {/* Right side panel (mock placeholder). */}
      <div className="w-72 shrink-0 border-l border-border bg-smui-surface-sunken" />
    </div>
  ),
};
