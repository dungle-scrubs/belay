import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChevronRight, LoaderIcon, ShieldAlert, Terminal } from "lucide-react";
import { useState } from "react";
import { compactDisplay as display } from "./compact-fixtures";
import { CompactRow } from "./compact-row";

/**
 * Plan 05 (M2): the shared one-line compact row, Storybook-first. States cover the lifecycle (running,
 * done, error, info), detail-eligible vs not, long primary/secondary truncation, a narrow frame, and a
 * high-density stack. Fixed-height + truncation keep every row to one line. Rendered in a fixed-width
 * panel under the global centering decorator.
 */

const meta: Meta<typeof CompactRow> = {
  title: "Chat/CompactRow",
  component: CompactRow,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof CompactRow>;

function Panel({ children, width = 520 }: { children: React.ReactNode; width?: number }) {
  return (
    <div
      style={{ width, flexShrink: 0 }}
      className="overflow-hidden rounded-lg border border-border bg-background p-2"
    >
      {children}
    </div>
  );
}

export const Running: Story = {
  render: () => (
    <Panel>
      <CompactRow
        display={display({
          status: "running",
          icon: LoaderIcon,
          primary: "grep",
          secondary: "TODO across src/",
        })}
      />
    </Panel>
  ),
};

export const Done: Story = {
  render: () => (
    <Panel>
      <CompactRow display={display({ status: "done" })} />
    </Panel>
  ),
};

export const ErrorState: Story = {
  render: () => (
    <Panel>
      <CompactRow
        display={display({
          status: "error",
          primary: "write",
          secondary: "error: permission denied",
        })}
      />
    </Panel>
  ),
};

export const Info: Story = {
  render: () => (
    <Panel>
      <CompactRow
        display={display({
          kind: "guardrail",
          status: "info",
          icon: ShieldAlert,
          primary: "Guardrail: bash",
          secondary: "repeated identical failure",
        })}
      />
    </Panel>
  ),
};

/** A detail-eligible row: clicking it expands the detail below (interactive). */
export const DetailEligible: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <Panel>
        <CompactRow
          display={display({ hasDetail: true, secondary: "src/server.ts" })}
          expanded={open}
          onToggle={() => setOpen((v) => !v)}
        >
          <pre className="whitespace-pre-wrap">
            {"export function createServer() {\n  // ...\n}"}
          </pre>
        </CompactRow>
      </Panel>
    );
  },
};

export const NoDetail: Story = {
  render: () => (
    <Panel>
      <CompactRow
        display={display({ hasDetail: false, primary: "read", secondary: "README.md" })}
      />
    </Panel>
  ),
};

export const LongCommand: Story = {
  render: () => (
    <Panel>
      <CompactRow
        display={display({
          kind: "shell",
          icon: Terminal,
          primary:
            "git log --oneline --graph --decorate --all --since='2 weeks ago' --author=kevin",
          secondary: "exit 0",
        })}
      />
    </Panel>
  ),
};

export const LongPath: Story = {
  render: () => (
    <Panel>
      <CompactRow
        display={display({
          icon: ChevronRight,
          primary: "read",
          secondary:
            "apps/web/src/components/chat/very/deeply/nested/path/to/the/transcript/row/module.tsx",
          hasDetail: true,
        })}
        onToggle={() => {}}
      />
    </Panel>
  ),
};

export const Narrow: Story = {
  render: () => (
    <Panel width={280}>
      <CompactRow
        display={display({ primary: "multi_edit", secondary: "src/a.ts, src/b.ts, src/c.ts" })}
      />
    </Panel>
  ),
};

/** A dense stack of mixed rows - the compact language at transcript scale. */
export const HighDensity: Story = {
  render: () => (
    <Panel>
      <div className="flex flex-col gap-0.5">
        <CompactRow
          display={display({
            status: "running",
            icon: LoaderIcon,
            primary: "bash",
            secondary: "pnpm test",
          })}
        />
        <CompactRow
          display={display({ primary: "read", secondary: "src/app.ts", hasDetail: true })}
          onToggle={() => {}}
        />
        <CompactRow display={display({ primary: "grep", secondary: "useState" })} />
        <CompactRow
          display={display({ status: "error", primary: "edit", secondary: "error: no match" })}
        />
        <CompactRow
          display={display({
            kind: "shell",
            icon: Terminal,
            primary: "git status",
            secondary: "clean",
          })}
        />
        <CompactRow
          display={display({
            kind: "guardrail",
            status: "info",
            icon: ShieldAlert,
            primary: "Guardrail: read",
            secondary: "no progress",
          })}
        />
      </div>
    </Panel>
  ),
};
