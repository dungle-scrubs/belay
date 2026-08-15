import type { ArtifactRef } from "@belay/session";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { CommandMenu } from "@/components/chat/command-menu";
import { PromptInput } from "@/components/chat/prompt-input";

/**
 * Drives the REAL production composer (PromptInput, the same component App renders) with local
 * state, so Storybook exercises the actual prompt input - its bordered surface, attach button,
 * attachment chips, upload-error banner, and the prompt-shell-lane (`!`) terminal treatment - not an
 * assistant-ui mock. Each story seeds a different draft / attachment set to show one composer state.
 */
function ComposerHarness({
  initialDraft = "",
  attachments = [],
  uploading = 0,
  uploadError = null,
  showSlashMenu = false,
  vimEnabled = false,
}: {
  initialDraft?: string;
  attachments?: readonly ArtifactRef[];
  uploading?: number;
  uploadError?: string | null;
  showSlashMenu?: boolean;
  vimEnabled?: boolean;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [caret, setCaret] = useState(initialDraft.length);
  const [chips, setChips] = useState<readonly ArtifactRef[]>(attachments);
  const [error, setError] = useState<string | null>(uploadError);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The composer-owned slice PromptInput reads (a subset of the live `useComposer` Composer); the
  // story fakes only the fields the input actually uses.
  const composer = {
    draft,
    setDraft,
    attachments: chips,
    uploading,
    uploadError: error,
    setUploadError: setError,
    inputRef,
    fileInputRef,
    onPickFiles: () => {},
    onPaste: () => {},
    handleKeyDown: () => {},
    removeAttachment: (hash: string) => setChips((a) => a.filter((ref) => ref.hash !== hash)),
  };

  // The slash menu lives in App as an absolute overlay above this input; mirror that layout so the
  // story shows the shell chrome is distinct from the slash menu.
  const slashMatches = [
    { name: "/doctor", summary: "Host health: workspace, providers, tools" },
    { name: "/shell", summary: "Run a shell command on the host", usage: "/shell <command>" },
  ];

  return (
    <div className="mx-auto w-full max-w-2xl bg-smui-surface-sunken p-4">
      <div className="relative pt-2 pb-4">
        {showSlashMenu ? (
          <CommandMenu
            className="absolute inset-x-0 bottom-full z-20 mb-2"
            matches={slashMatches}
            activeIndex={0}
            query={draft}
            onPick={(name) => setDraft(`${name} `)}
          />
        ) : null}
        <PromptInput
          composer={composer}
          onSubmit={(event) => event.preventDefault()}
          onKeyDown={() => {}}
          caret={caret}
          onCaretChange={setCaret}
          disabled={false}
          placeholder="message qwen… (/ for commands, ! for shell)"
          vimEnabled={vimEnabled}
          menuOpen={showSlashMenu}
        />
      </div>
    </div>
  );
}

const HEX64 = "a".repeat(64);
const imageAttachment: ArtifactRef = {
  kind: "document",
  mimeType: "text/plain",
  size: 1024,
  hash: HEX64,
  name: "notes.txt",
};

const meta = {
  title: "Components/PromptInput",
  component: ComposerHarness,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ComposerHarness>;

export default meta;

type Story = StoryObj<typeof meta>;

/** An ordinary prompt: the neutral bordered composer. */
export const Normal: Story = {
  render: () => <ComposerHarness initialDraft="refactor the turn scheduler" />,
};

/** A leading `/`: the slash-command menu overlays above the input. The composer chrome itself is
 *  unchanged - that's how the shell treatment stays distinct from the slash menu. */
export const Slash: Story = {
  render: () => <ComposerHarness initialDraft="/do" showSlashMenu />,
};

/** A lone `!`: the terminal-orange styling + shell glyph appear immediately (no height reflow), but
 *  nothing executes (no command yet). The inert state before a command is typed. */
export const EmptyBang: Story = {
  name: "Empty bang",
  render: () => <ComposerHarness initialDraft="!" />,
};

/** A leading `!` with a command: the executable shell lane - terminal-orange border / background /
 *  monospace text, with the attach `+` swapped for the shell glyph. Submitting runs it on the host. */
export const ExecutableBang: Story = {
  name: "Executable bang",
  render: () => <ComposerHarness initialDraft="!git status --short" />,
};

/** A long shell command: the textarea grows and the terminal styling holds across multiple lines. */
export const LongBang: Story = {
  name: "Long bang command",
  render: () => (
    <ComposerHarness initialDraft="!find apps -name '*.test.ts' -newer package.json -print | head -50 | sort -u" />
  ),
};

/** A bang command with a pending attachment and an upload error: shell is text-only, so the
 *  attachment stays in the composer (handled explicitly, never silently dropped). */
export const BangWithAttachment: Story = {
  name: "Bang with attachment + error",
  render: () => (
    <ComposerHarness
      initialDraft="!cat notes.txt"
      attachments={[imageAttachment]}
      uploadError="couldn't attach huge.bin: file too large"
    />
  ),
};

/** Vim mode enabled (plan 06): the INSERT indicator rides the bottom row next to the expand button.
 *  Focus the textarea and press Escape to walk insert -> normal -> visual (the indicator updates). */
export const VimMode: Story = {
  name: "Vim mode (enabled)",
  render: () => <ComposerHarness initialDraft="refactor the turn scheduler" vimEnabled />,
};

/** Vim mode in the shell lane: the indicator keeps its place next to the shell glyph. */
export const VimShellLane: Story = {
  name: "Vim mode + shell lane",
  render: () => <ComposerHarness initialDraft="!pnpm test" vimEnabled />,
};
