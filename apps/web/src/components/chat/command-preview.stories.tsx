import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CommandSpec } from "@trevor/session";
import { useState } from "react";
import { commandArgPreview } from "@/derive";
import { CommandPreview } from "./command-preview";

/**
 * The live substitution preview (plan 44.5 M6). A file-loaded custom command `/fix` announces its body
 * `Fix issue #$0 for $ARGUMENTS`; typing past the first space shows what the host will submit, with the
 * `$0`/`$ARGUMENTS` placeholders resolved live.
 */
const FIX: CommandSpec = {
  name: "/fix",
  summary: "Fix an issue",
  argumentHint: "<issue-number> <note>",
  body: "Fix issue #$0.\n\nNotes: $ARGUMENTS",
};

const meta: Meta = {
  title: "Chat/CommandPreview",
  parameters: { layout: "centered" },
};

export default meta;

type Story = StoryObj;

/** Type into the composer to watch the substitution resolve as `/fix ‹args›` fills in. */
function CommandPreviewDemo() {
  const [draft, setDraft] = useState("/fix 4213 flaky in CI");
  const preview = commandArgPreview(draft, [FIX]);

  return (
    <div className="w-[34rem] max-w-full">
      <div className="relative">
        {preview ? (
          <CommandPreview className="absolute inset-x-0 bottom-full z-20 mb-2" preview={preview} />
        ) : null}
        <input
          // biome-ignore lint/a11y/noAutofocus: storybook demo - focus so typing works immediately.
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="/fix <issue> …"
          className="w-full border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-ring"
        />
      </div>
    </div>
  );
}

export const Interactive: Story = {
  render: () => <CommandPreviewDemo />,
};

/** A static frame with both placeholders filled. */
export const Filled: Story = {
  render: () => (
    <div className="w-[34rem] max-w-full">
      <CommandPreview preview={commandArgPreview("/fix 4213 flaky in CI", [FIX]) as never} />
    </div>
  ),
};

/** A static frame with `$0` still empty - the "waiting on" cue shows. */
export const AwaitingArg: Story = {
  render: () => (
    <div className="w-[34rem] max-w-full">
      <CommandPreview preview={commandArgPreview("/fix ", [FIX]) as never} />
    </div>
  ),
};
