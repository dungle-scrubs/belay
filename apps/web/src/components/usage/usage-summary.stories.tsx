import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  emptyUsage,
  midTurnSwitchUsage,
  typicalUsage,
  untrustedUsage,
  withFailuresUsage,
} from "./usage-fixtures";
import { UsageSummary } from "./usage-summary";

/**
 * The usage-summary surface (plan 43 M3). A conservative, source-attributed read of one session's
 * usage - totals, per-provider and per-model breakdowns, and typed failure/retry rows - with a
 * copy/export button. These stories cover the everyday multi-provider case, a mid-turn model switch
 * (split into two model rows), a session with a retry and a failure, an untrusted local-model turn
 * (~ labels), and the empty state.
 */

const meta: Meta<typeof UsageSummary> = {
  title: "Chat/UsageSummary",
  component: UsageSummary,
  decorators: [
    (Story) => (
      <div className="w-80 rounded-md border p-3">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof UsageSummary>;

/** Two clean turns across two providers - the everyday case. */
export const Typical: Story = {
  render: () => <UsageSummary usage={typicalUsage()} />,
};

/** One turn that switched model mid-turn - usage is split across two model rows. */
export const MidTurnSwitch: Story = {
  render: () => <UsageSummary usage={midTurnSwitchUsage()} />,
};

/** A retried-then-completed turn plus a rate-limited failure - the failure/retry rows. */
export const WithFailures: Story = {
  render: () => <UsageSummary usage={withFailuresUsage()} />,
};

/** A local-model turn whose provider reports no usage - every figure carries a ~ estimate marker. */
export const Untrusted: Story = {
  render: () => <UsageSummary usage={untrustedUsage()} />,
};

/** No turns yet - the empty state. */
export const Empty: Story = {
  render: () => <UsageSummary usage={emptyUsage()} />,
};
