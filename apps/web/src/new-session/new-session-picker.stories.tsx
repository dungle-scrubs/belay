import type { SupervisorProject } from "@belay/session";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { NewSessionPicker } from "./new-session-picker";

/**
 * Plan 44.2 M2: the New-session picker, Storybook-first over injected props. Covers recents vs. empty
 * recents, the path field's empty/invalid/valid validation (Create disabled until valid), the native
 * folder icon shown (local) vs. hidden (remote), and the in-flight "starting host…" state - which locks
 * every control and swaps Create in place with NO layout shift (fixed heights throughout).
 */

const NOW = Date.parse("2026-07-04T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const project = (root: string, ms: number): SupervisorProject => ({
  root,
  sessionId: `sess-${root.split("/").filter(Boolean).pop()}`,
  updatedAt: ago(ms),
});

const RECENTS: SupervisorProject[] = [
  project("~/dev/belay", 1000 * 60 * 12),
  project("~/dev/opchain", 1000 * 60 * 60 * 4),
  project("~/dev/launchdawg", 1000 * 60 * 60 * 24),
  project("~/dev/emberlm", 1000 * 60 * 60 * 24 * 3),
  project("~/work/experiments/a-rather-long-project-directory-name", 1000 * 60 * 60 * 24 * 9),
];

const noop = () => {};

const meta = {
  title: "NewSession/NewSessionPicker",
  component: NewSessionPicker,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-full bg-background">
        <Story />
      </div>
    ),
  ],
  args: {
    open: true,
    onOpenChange: noop,
    recents: RECENTS,
    path: "",
    validation: "empty",
    localPickerAvailable: true,
    launchState: "idle",
    error: null,
    onPickRecent: noop,
    onPickFolder: noop,
    onPathChange: noop,
    onCreate: noop,
    nowMs: NOW,
  },
} satisfies Meta<typeof NewSessionPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Recents loaded, path empty: Create is disabled until a valid path is entered or a recent is picked. */
export const Recents: Story = {};

export const EmptyRecents: Story = {
  args: { recents: [] },
};

export const PathInvalid: Story = {
  args: { path: "not-a-path", validation: "invalid" },
};

/** A valid absolute path enables Create. */
export const PathValid: Story = {
  args: { path: "~/dev/new-thing", validation: "valid" },
};

/** A remote/headless backend hides the native folder icon and degrades to recents + paste-a-path. */
export const FolderIconHidden: Story = {
  args: { localPickerAvailable: false },
};

/** A launch is in flight: every control is locked and the footer shows "starting host…" IN PLACE - the
 *  modal keeps the exact size it had at idle (fixed heights, no reflow). */
export const StartingHost: Story = {
  args: { path: "~/dev/new-thing", validation: "valid", launchState: "starting" },
};

/** An inline launch error at idle - the timeout-back-to-idle case, where Create is still offered. */
export const LaunchError: Story = {
  args: { path: "~/dev/new-thing", validation: "valid", error: "no local supervisor available" },
};

/** A failed launch (plan 44.3): the controls lock and the footer swaps Create for an explicit Retry
 *  beside the named error - the one deterministic way out, IN PLACE (no reflow). */
export const FailedWithRetry: Story = {
  args: {
    path: "~/dev/new-thing",
    validation: "valid",
    launchState: "failed",
    error: "no local supervisor available",
  },
};
