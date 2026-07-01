import type { Meta, StoryObj } from "@storybook/react-vite";
import { BranchButton } from "./BranchButton";
import { LineageNavigator } from "./LineageNavigator";
import type { Lineage } from "./lineage";

/**
 * The fork lineage navigator + the "branch from here" affordance (plan 15, M3), driven by lineage
 * fixtures so every state is reviewable without a live store: a root session, a deep chain, children,
 * and a parent that has left the inventory (a non-navigable stub).
 */
const meta: Meta<typeof LineageNavigator> = {
  title: "Fork/Lineage",
  component: LineageNavigator,
  args: { onNavigate: () => {} },
};
export default meta;

type Story = StoryObj<typeof LineageNavigator>;

const deep: Lineage = {
  ancestors: [
    { sessionId: "root", title: "Initial exploration" },
    { sessionId: "mid", title: "Tried approach A", forkSeq: 4 },
  ],
  current: { sessionId: "leaf", title: "Trying approach B", forkSeq: 9 },
  children: [{ sessionId: "kid", title: "Variant with tests", forkSeq: 12 }],
};

export const DeepChain: Story = { args: { lineage: deep } };

export const RootWithChildren: Story = {
  args: {
    lineage: {
      ancestors: [],
      current: { sessionId: "root", title: "Main session" },
      children: [
        { sessionId: "a", title: "Branch: alt fix", forkSeq: 6 },
        { sessionId: "b", title: "Branch: refactor", forkSeq: 10 },
      ],
    },
  },
};

export const MissingParent: Story = {
  args: {
    lineage: {
      ancestors: [{ sessionId: "gone", title: "gone", missing: true }],
      current: { sessionId: "leaf", title: "Orphaned branch", forkSeq: 3 },
      children: [],
    },
  },
};

export const BranchAffordance: StoryObj<typeof BranchButton> = {
  render: () => <BranchButton forkSeq={7} onBranch={() => {}} />,
};
