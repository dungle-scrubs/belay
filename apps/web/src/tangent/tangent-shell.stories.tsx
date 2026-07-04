import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useState } from "react";
import { TangentShell, type TangentTurn } from "./tangent-shell";

/**
 * The tangent takeover shell (plan 37): a center-column surface that replaces the transcript/composer
 * while the sidebars stay visible, like the model chooser / archive / tool-detail takeovers - a top-left
 * back arrow, a labelled source-quote header so it reads as a scoped side conversation, the tangent's own
 * turns, and its own composer. Because it takes over the center column, the stories frame it in a
 * fixed-size panel using INLINE pixel dimensions (independent of Tailwind arbitrary-width JIT), and the
 * BothSidebarsVisible / NarrowAfterSidebars frames show it adapting to the space left when the sidebars stay.
 */
const noop = () => {};

const SEED =
  "Blobs are content-addressed by their sha256, so identical content is stored exactly once.";

const CONVERSATION: TangentTurn[] = [
  {
    id: "u1",
    role: "user",
    text: "Why sha256 rather than a random uuid for the blob name?",
  },
  {
    id: "a1",
    role: "assistant",
    text: "Because a **content hash** makes storage idempotent: the same bytes always resolve to the same name, so a re-upload is a no-op and every reference is automatically de-duplicated. A uuid would mint a new name each time and lose that property.",
  },
];

function Panel({ children, width = 720 }: { children: ReactNode; width?: number }) {
  return (
    <div
      style={{ width, height: 660, flexShrink: 0 }}
      className="overflow-hidden rounded-lg border border-border"
    >
      {children}
    </div>
  );
}

const meta: Meta<typeof TangentShell> = {
  title: "Tangent/TangentShell",
  component: TangentShell,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof TangentShell>;

const baseComposer = {
  draft: "",
  onDraftChange: noop,
  onSend: noop,
  placeholder: "Ask in this tangent…",
};

export const Empty: Story = {
  render: () => (
    <Panel>
      <TangentShell
        className="h-full"
        sourceQuote={SEED}
        parentLabel="Blob store design"
        turns={[]}
        composer={baseComposer}
        onBack={noop}
      />
    </Panel>
  ),
};

export const Seeded: Story = {
  render: () => (
    <Panel>
      <TangentShell
        className="h-full"
        sourceQuote={SEED}
        parentLabel="Blob store design"
        turns={[CONVERSATION[0] as TangentTurn]}
        composer={baseComposer}
        onBack={noop}
      />
    </Panel>
  ),
};

export const ActiveTurn: Story = {
  render: () => (
    <Panel>
      <TangentShell
        className="h-full"
        sourceQuote={SEED}
        parentLabel="Blob store design"
        turns={[
          CONVERSATION[0] as TangentTurn,
          {
            id: "a1",
            role: "assistant",
            text: "Because a content hash makes storage",
            streaming: true,
          },
        ]}
        busy
        composer={{ ...baseComposer, disabled: true }}
        onBack={noop}
      />
    </Panel>
  ),
};

export const Completed: Story = {
  render: () => (
    <Panel>
      <TangentShell
        className="h-full"
        sourceQuote={SEED}
        parentLabel="Blob store design"
        turns={CONVERSATION}
        composer={baseComposer}
        onBack={noop}
      />
    </Panel>
  ),
};

export const ErrorCreating: Story = {
  render: () => (
    <Panel>
      <TangentShell
        className="h-full"
        sourceQuote={SEED}
        turns={[]}
        error="The session store is unreachable. Try again in a moment."
        composer={{ ...baseComposer, disabled: true }}
        onBack={noop}
      />
    </Panel>
  ),
};

export const FoldBackAvailable: Story = {
  render: () => {
    const [note, setNote] = useState<{ tone: "success" | "error"; text: string } | null>(null);
    return (
      <Panel>
        <TangentShell
          className="h-full"
          sourceQuote={SEED}
          parentLabel="Blob store design"
          turns={CONVERSATION}
          composer={baseComposer}
          onFoldBack={() =>
            setNote({ tone: "success", text: "Sent to the parent composer for review." })
          }
          foldBackNote={note}
          onBack={noop}
        />
      </Panel>
    );
  },
};

export const Narrow: Story = {
  render: () => (
    <Panel width={360}>
      <TangentShell
        className="h-full"
        sourceQuote={SEED}
        parentLabel="Blob store design"
        turns={CONVERSATION}
        composer={baseComposer}
        onFoldBack={noop}
        onBack={noop}
      />
    </Panel>
  ),
};

export const BothSidebarsVisible: Story = {
  render: () => (
    <div
      style={{ width: 1160, height: 660 }}
      className="flex overflow-hidden rounded-lg border border-border"
    >
      <div className="w-56 shrink-0 border-r border-border bg-smui-surface-sunken p-3 text-xs text-muted-foreground">
        session sidebar
      </div>
      <div className="min-w-0 flex-1">
        <TangentShell
          className="h-full"
          sourceQuote={SEED}
          parentLabel="Blob store design"
          turns={CONVERSATION}
          composer={baseComposer}
          onFoldBack={noop}
          onBack={noop}
        />
      </div>
      <div className="w-64 shrink-0 border-l border-border bg-smui-surface-sunken p-3 text-xs text-muted-foreground">
        details panel
      </div>
    </div>
  ),
};

export const NarrowAfterSidebars: Story = {
  render: () => (
    <div
      style={{ width: 900, height: 660 }}
      className="flex overflow-hidden rounded-lg border border-border"
    >
      <div className="w-56 shrink-0 border-r border-border bg-smui-surface-sunken p-3 text-xs text-muted-foreground">
        session sidebar
      </div>
      <div className="min-w-0 flex-1">
        <TangentShell
          className="h-full"
          sourceQuote={SEED}
          parentLabel="Blob store design"
          turns={CONVERSATION}
          composer={baseComposer}
          onFoldBack={noop}
          onBack={noop}
        />
      </div>
    </div>
  ),
};
