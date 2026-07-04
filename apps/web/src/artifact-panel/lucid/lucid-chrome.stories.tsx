import type { Meta, StoryObj } from "@storybook/react-vite";
import type { LucidAnchor } from "@trevor/session";
import { LucidChrome } from "./lucid-chrome";
import {
  commitLucidDraft,
  createLucidPanelState,
  editLucidDraftNote,
  type LucidPanelState,
  targetLucidElement,
} from "./lucid-panel-state";

/**
 * The Lucid review CHROME (plan 27, M7) across its states: drafting, queued, orphaned, approved, and a
 * deferred newer version. State is built with the pure reducer so each story is a faithful snapshot.
 */
const meta = {
  title: "ArtifactPanel/LucidChrome",
  component: LucidChrome,
  tags: ["artifact-panel", "lucid"],
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-[420px] border border-border bg-card">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LucidChrome>;

export default meta;
type Story = StoryObj<typeof LucidChrome>;

const anchor = (id: string): LucidAnchor => ({ type: "element", lucidId: id });
const noop = () => {};

function base(state: LucidPanelState) {
  return {
    state,
    delivered: null,
    onEditNote: noop,
    onCommit: noop,
    onDiscard: noop,
    onRemoveQueued: noop,
    onDeliver: noop,
    onApplyVersion: noop,
    onResolve: noop,
    onReopen: noop,
  };
}

function withDraft(note = ""): LucidPanelState {
  const s = targetLucidElement(createLucidPanelState({ lucidId: "roadmap", version: 1 }), {
    anchor: anchor("hero"),
    snippet: "Ship the beta on Friday",
  });
  return note ? editLucidDraftNote(s, note) : s;
}

function withQueue(...ids: string[]): LucidPanelState {
  let s = createLucidPanelState({ lucidId: "roadmap", version: 1 });
  for (const id of ids) {
    s = targetLucidElement(s, { anchor: anchor(id), snippet: `snippet ${id}` });
    s = editLucidDraftNote(s, `feedback on ${id}`);
    s = commitLucidDraft(s, id);
  }
  return s;
}

export const Empty: Story = {
  args: base(createLucidPanelState({ lucidId: "roadmap", version: 1 })),
};
export const Drafting: Story = { args: base(withDraft("make this bolder")) };
export const Queued: Story = { args: base(withQueue("a1", "a2")) };

export const Orphaned: Story = {
  args: base({
    ...withQueue("a1", "a2"),
    version: 2,
    queue: withQueue("a1", "a2").queue.map((q, i) => ({ ...q, orphaned: i === 0 })),
  }),
};

export const DeferredVersion: Story = {
  args: base({ ...withQueue("a1"), pendingVersion: 2 }),
};

export const Approved: Story = {
  args: base(createLucidPanelState({ lucidId: "roadmap", version: 2, reviewStatus: "resolved" })),
};

export const NarrowPanel: Story = {
  args: base(withQueue("a1")),
  decorators: [
    (Story) => (
      <div className="w-[260px] border border-border bg-card">
        <Story />
      </div>
    ),
  ],
};
