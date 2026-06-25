import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { DoctorSnapshot } from "@/commands/doctor";
import {
  healthySnapshot,
  loadingSnapshot,
  longPathsSnapshot,
  manyFindingsSnapshot,
  mixedSnapshot,
  notCheckedSnapshot,
  refreshingSnapshot,
  staleSnapshot,
} from "./doctor-fixtures";
import { DoctorPanel } from "./doctor-panel";

/**
 * The `/doctor` health panel rendered from fixture `doctor.current` snapshots
 * (D-073). One panel - a summary header over a single divided list of area rows.
 * Healthy areas are quiet one-liners; warnings and errors expand inline. Toggle
 * the toolbar Theme to check both SMUI modes.
 */
const meta: Meta<typeof DoctorPanel> = {
  title: "Chat/Doctor/Panel",
  component: DoctorPanel,
  parameters: { layout: "fullscreen" },
};

export default meta;

type Story = StoryObj<typeof DoctorPanel>;

// In the live app these drive host commands; here they just report the intent.
const ACTIONS = {
  onRefresh: () => window.alert("/doctor refresh"),
  onCopyReport: () => window.alert("copy report"),
  onViewJson: () => window.alert("/doctor json"),
};

/** The panel reads as a command result: a single column at a comfortable width. */
const Frame = ({ children }: { children: React.ReactNode }) => (
  <div className="mx-auto w-full max-w-3xl">{children}</div>
);

/** All twelve areas healthy - twelve quiet lines, no boxes. */
export const AllHealthy: Story = {
  render: () => (
    <Frame>
      <DoctorPanel snapshot={healthySnapshot} actions={ACTIONS} />
    </Frame>
  ),
};

/** A realistic degraded host: an auth error and several warnings expand inline;
 *  the healthy areas stay one-liners. */
export const MixedWarningsErrors: Story = {
  render: () => (
    <Frame>
      <DoctorPanel snapshot={mixedSnapshot} actions={ACTIONS} />
    </Frame>
  ),
};

/** Findings across nearly every area - the dense worst case, still one panel. */
export const ManyFindings: Story = {
  render: () => (
    <Frame>
      <DoctorPanel snapshot={manyFindingsSnapshot} actions={ACTIONS} />
    </Frame>
  ),
};

/** Nothing probed yet - every area degrades to "not checked". */
export const AllNotChecked: Story = {
  render: () => (
    <Frame>
      <DoctorPanel snapshot={notCheckedSnapshot} actions={ACTIONS} />
    </Frame>
  ),
};

/** First probe in flight, nothing to show yet - the skeleton. */
export const Loading: Story = {
  render: () => (
    <Frame>
      <DoctorPanel snapshot={loadingSnapshot} actions={ACTIONS} />
    </Frame>
  ),
};

/** A re-probe over the previous data: the header shows "Refreshing…" but the
 *  existing findings stay on screen. */
export const Refreshing: Story = {
  render: () => (
    <Frame>
      <DoctorPanel snapshot={refreshingSnapshot} actions={ACTIONS} />
    </Frame>
  ),
};

/** Healthy data that has aged past its freshness window. */
export const Stale: Story = {
  render: () => (
    <Frame>
      <DoctorPanel snapshot={staleSnapshot} actions={ACTIONS} />
    </Frame>
  ),
};

/** Long model ids, deep paths, and long errors - everything wraps in-panel. */
export const LongPaths: Story = {
  render: () => (
    <Frame>
      <DoctorPanel snapshot={longPathsSnapshot} actions={ACTIONS} />
    </Frame>
  ),
};

/** Phone width: the same single column, tighter. */
export const Mobile: Story = {
  render: () => (
    <div className="w-[390px] max-w-full">
      <DoctorPanel snapshot={mixedSnapshot} actions={ACTIONS} />
    </div>
  ),
};

/** Tablet width: the header band spreads into one row above the list. */
export const Tablet: Story = {
  render: () => (
    <div className="w-[768px] max-w-full">
      <DoctorPanel snapshot={mixedSnapshot} actions={ACTIONS} />
    </div>
  ),
};

/** Desktop width: the panel caps its width so the rows stay readable. */
export const Desktop: Story = {
  render: () => (
    <div className="w-[1100px] max-w-full">
      <DoctorPanel snapshot={mixedSnapshot} actions={ACTIONS} />
    </div>
  ),
};

/** Working refresh + expandable rows: refresh flips the header to "refreshing"
 *  for ~1.2s; click any row with a chevron to reveal its key facts. */
function InteractivePanel() {
  const [snapshot, setSnapshot] = useState<DoctorSnapshot>(mixedSnapshot);

  const onRefresh = () => {
    setSnapshot((prev) => ({ ...prev, state: "refreshing" }));
    setTimeout(() => {
      setSnapshot({ ...mixedSnapshot, state: "ready", checkedAt: "checked just now" });
    }, 1200);
  };

  return (
    <Frame>
      <DoctorPanel
        snapshot={snapshot}
        actions={{ ...ACTIONS, onRefresh }}
        onAction={(finding) => window.alert(`next action: ${finding.nextAction?.label}`)}
      />
    </Frame>
  );
}

export const Interactive: Story = {
  render: () => <InteractivePanel />,
};
