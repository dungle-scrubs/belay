import type { GitStatus, UsageBreakdown } from "@belay/session";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { HostLaunchStatus } from "@/new-session/host-launch-status";
import {
  SidePanel,
  SidePanelBreakdown,
  type SidePanelBreakdownProps,
  SidePanelHeader,
  type SidePanelHeaderProps,
} from "./side-panel";

const cleanMain: GitStatus = {
  branch: "main",
  detached: null,
  dirty: false,
  ahead: 0,
  behind: 0,
  upstream: true,
  worktree: false,
};

const dirtyAhead: GitStatus = {
  branch: "feat/cross-turn-compaction",
  detached: null,
  dirty: true,
  ahead: 2,
  behind: 1,
  upstream: true,
  worktree: false,
};

// A realistic turn: tool results dominate the input, thinking dominates the
// output, the answer is a slice, plus the fixed prompt overhead.
const breakdown: UsageBreakdown = {
  input: {
    systemAndTools: 2400,
    userText: 820,
    assistantText: 640,
    toolCallArgs: 520,
    toolResults: 9800,
    imagesBase64: 0,
    imageCount: 0,
    byTool: { read: 4200, bash: 2600, grep: 1800, edit: 1200 },
  },
  output: { thinking: 3800, answer: 1900, toolCallArgs: 520 },
};

// The whole context window: every request so far, accumulated. Tool results
// dominate as read/bash/grep output piles up across the turns.
const contextBreakdown: UsageBreakdown = {
  input: {
    systemAndTools: 2400,
    userText: 6800,
    assistantText: 9200,
    toolCallArgs: 4100,
    toolResults: 78000,
    imagesBase64: 0,
    imageCount: 0,
    byTool: { read: 34000, bash: 21000, grep: 14000, edit: 9000 },
  },
  output: { thinking: 22000, answer: 12000, toolCallArgs: 4100 },
};

const Controls = (
  <>
    <button
      type="button"
      className="flex items-center justify-between border border-border px-3 py-2 text-sm hover:bg-secondary"
    >
      <span className="text-muted-foreground">model</span>
      <span className="text-foreground">qwen 4-bit ▾</span>
    </button>
    <button
      type="button"
      className="flex items-center justify-between border border-border px-3 py-2 text-sm hover:bg-secondary"
    >
      <span className="text-muted-foreground">reasoning</span>
      <span className="text-foreground">off ▾</span>
    </button>
  </>
);

const Footer = (
  <>
    <button
      type="button"
      className="flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-label tracking-wider text-muted-foreground hover:text-foreground"
    >
      resume
    </button>
    <button
      type="button"
      className="flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-label tracking-wider text-muted-foreground hover:text-foreground"
    >
      worktree
    </button>
    <div className="ml-auto truncate rounded border border-border bg-background px-2 py-1 font-mono text-label tracking-wider text-muted-foreground">
      belay-local
    </div>
  </>
);

const meta = {
  title: "Panel/SidePanel",
  component: SidePanel,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[680px] justify-end bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SidePanel>;

export default meta;
type SidePanelStoryArgs = SidePanelHeaderProps &
  SidePanelBreakdownProps & {
    readonly controls?: ReactNode;
    readonly footer?: ReactNode;
  };
type Story = StoryObj<SidePanelStoryArgs>;

function renderSidePanel({
  title,
  subtitle,
  statusNode,
  workspace,
  git,
  controls,
  footer,
  ...breakdown
}: SidePanelStoryArgs) {
  return (
    <SidePanel controls={controls} footer={footer} ready={breakdown.ready}>
      <SidePanelHeader
        title={title}
        subtitle={subtitle}
        statusNode={statusNode}
        workspace={workspace}
        git={git}
      />
      <SidePanelBreakdown {...breakdown} />
    </SidePanel>
  );
}

export const Default: Story = {
  render: renderSidePanel,
  args: {
    title: "auth-flow",
    subtitle: "session · belay-local",
    workspace: "~/proj/api",
    git: cleanMain,
    ctxUsed: 128000,
    ctxMax: 200000,
    totalTokens: 14100,
    breakdown,
    contextTokens: 128000,
    contextBreakdown,
    controls: Controls,
    footer: Footer,
  },
};

export const NoImagesHeavyThinking: Story = {
  render: renderSidePanel,
  args: {
    title: "refactor-loop",
    subtitle: "session · belay-local",
    workspace: "~/dev/belay",
    git: dirtyAhead,
    ctxUsed: 82000,
    ctxMax: 200000,
    totalTokens: 8200,
    breakdown: {
      input: {
        systemAndTools: 2400,
        userText: 300,
        assistantText: 200,
        toolCallArgs: 180,
        toolResults: 2100,
        imagesBase64: 0,
        imageCount: 0,
        byTool: { read: 1500, grep: 600 },
      },
      output: { thinking: 5200, answer: 700, toolCallArgs: 180 },
    },
    controls: Controls,
  },
};

export const Empty: Story = {
  render: renderSidePanel,
  args: {
    title: "belay-local",
    subtitle: "no call yet",
    workspace: "~/dev/belay",
    ctxUsed: 0,
    ctxMax: 200000,
    controls: Controls,
  },
};

// Context-pressure bands (plan 32): the meter carries pressure through color as usage
// approaches the window. One story per band boundary so the visual-regression lane pins
// each treatment (D-001/D-002).

const pressureArgs = {
  title: "auth-flow",
  subtitle: "session · belay-local",
  workspace: "~/proj/api",
  git: cleanMain,
  breakdown,
  totalTokens: 14100,
  controls: Controls,
} satisfies Partial<SidePanelStoryArgs>;

/** Normal band: 42% of the window, quiet primary fill, no pressure implied. */
export const PressureNormal: Story = {
  render: renderSidePanel,
  args: { ...pressureArgs, ctxUsed: 84_000, ctxMax: 200_000 },
};

/** Warning band: 72% - long tool output/reasoning could start to matter soon. */
export const PressureWarning: Story = {
  render: renderSidePanel,
  args: { ...pressureArgs, ctxUsed: 144_000, ctxMax: 200_000 },
};

/** Danger band: 91% - meaningful risk of context pressure. */
export const PressureDanger: Story = {
  render: renderSidePanel,
  args: { ...pressureArgs, ctxUsed: 182_000, ctxMax: 200_000 },
};

/** Critical band: 97% - overflow/recovery likely; restrained stronger treatment. */
export const PressureCritical: Story = {
  render: renderSidePanel,
  args: { ...pressureArgs, ctxUsed: 194_000, ctxMax: 200_000 },
};

/** Exactly full: the bar caps at 100% and reads critical. */
export const PressureFull: Story = {
  render: renderSidePanel,
  args: { ...pressureArgs, ctxUsed: 200_000, ctxMax: 200_000 },
};

/** Over the window: usage exceeds the max, so the label reads past 100% while the bar stays capped. */
export const PressureOverWindow: Story = {
  render: renderSidePanel,
  args: { ...pressureArgs, ctxUsed: 216_000, ctxMax: 200_000 },
};

/** Long window label in the narrow (w-80) panel: the 1M-token window stays legible beside tokens+percent. */
export const PressureLongWindow: Story = {
  render: renderSidePanel,
  args: { ...pressureArgs, ctxUsed: 420_000, ctxMax: 1_000_000 },
};

// No-host recovery badge (plan 44.3): the `statusNode` variants the header shows when the viewed session
// has no live host. One story per state so the visual-regression lane pins each treatment.

const noHostArgs = {
  title: "auth-flow",
  subtitle: "session · belay-local",
  workspace: "~/proj/api",
  git: cleanMain,
  breakdown,
  totalTokens: 14100,
  ctxUsed: 84_000,
  ctxMax: 200_000,
  controls: Controls,
} satisfies Partial<SidePanelStoryArgs>;

const noop = () => {};

/** A no-host session with a resolvable root: the badge offers "Start host" (the entry point today lacks). */
export const NoHostStartable: Story = {
  render: renderSidePanel,
  args: {
    ...noHostArgs,
    statusNode: <HostLaunchStatus state={{ phase: "startable", onStart: noop }} />,
  },
};

/** A fresh host coming up after Start: "starting host…". */
export const StartingHost: Story = {
  render: renderSidePanel,
  args: {
    ...noHostArgs,
    statusNode: <HostLaunchStatus state={{ phase: "starting", restarting: false }} />,
  },
};

/** Replacing a stale/dead host that was here before: the distinct "restarting host…" label. */
export const RestartingStaleHost: Story = {
  render: renderSidePanel,
  args: {
    ...noHostArgs,
    statusNode: <HostLaunchStatus state={{ phase: "starting", restarting: true }} />,
  },
};

/** A failed launch: the named error plus an explicit Retry, right in the badge. */
export const FailedWithRetry: Story = {
  render: renderSidePanel,
  args: {
    ...noHostArgs,
    statusNode: (
      <HostLaunchStatus
        state={{ phase: "failed", error: "no local supervisor available", onRetry: noop }}
      />
    ),
  },
};
