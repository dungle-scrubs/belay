import { Maximize2, Plus, Terminal, X } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, type SubmitEvent, useEffect } from "react";
import { ArtifactThumb } from "@/ArtifactThumb";
import { VimModeIndicator } from "@/components/chat/vim-mode-indicator";
import { Button } from "@/components/ui/button";
import type { Composer } from "@/hooks/use-composer";
import { cn } from "@/lib/utils";
import { useVim } from "@/vim/use-vim";

/**
 * The production prompt composer: the bordered textarea + attach button, the pending-attachment
 * chips, and the upload-error banner. Extracted out of App.tsx so Storybook can exercise the REAL
 * composer (not an assistant-ui mock) across its states, and so the prompt-shell-lane visual
 * treatment lives in one place.
 *
 * State changes happen immediately as the raw first character is typed:
 *   - leading `/` is the slash-command menu (an overlay App owns above this input - no chrome here),
 *   - leading `!` is the prompt shell lane (D-082): a terminal-orange border / background / monospace
 *     text, with the bottom-row attach `+` swapped for a shell glyph (so the lane is marked WITHOUT a
 *     top chip that would reflow the composer height as you type). Distinct from the slash menu, the
 *     context-pressure yellow, the assistant/tool surfaces, and the command-result chrome.
 *
 * App keeps the surrounding wiring (the drop target, the slash menu overlay, submit/steer/queue);
 * this component is purely "what the composer looks like and accepts right now".
 */
/**
 * The composer-owned slice PromptInput reads, a subset of the full {@link Composer}. Passing the
 * cohesive object (not a flat re-spread of a dozen fields) means adding or renaming a composer field
 * is one edit on the hook, not a parallel edit in PanelHost's prop list.
 */
type ComposerInput = Pick<
  Composer,
  | "draft"
  | "setDraft"
  | "attachments"
  | "uploading"
  | "uploadError"
  | "setUploadError"
  | "inputRef"
  | "fileInputRef"
  | "onPickFiles"
  | "onPaste"
  | "handleKeyDown"
  | "removeAttachment"
>;

export interface PromptInputProps {
  readonly composer: ComposerInput;
  readonly onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  readonly disabled: boolean;
  readonly placeholder: string;
  /** Open the current draft in the full-surface prompt editor (02.12) for a larger writing area. */
  readonly onExpand?: () => void;
  /** Whether the host-owned Vim prompt mode is enabled (plan 06). When on, the composer gains the Vim
   *  layer + a mode indicator; when off it is exactly the plain composer. */
  readonly vimEnabled?: boolean;
}

export function PromptInput({
  composer,
  onSubmit,
  onKeyDown,
  disabled,
  placeholder,
  onExpand,
  vimEnabled = false,
}: PromptInputProps) {
  const {
    draft,
    setDraft,
    attachments,
    uploading,
    uploadError,
    setUploadError,
    inputRef,
    fileInputRef,
    onPickFiles,
    onPaste,
    handleKeyDown,
    removeAttachment,
  } = composer;
  // The opt-in Vim layer (plan 06): attaches the controller to this textarea. Disabled -> a no-op
  // (onKeyDown returns false for every key), so the composer behaves exactly as before.
  const vim = useVim(inputRef, vimEnabled);
  // The prompt shell lane is triggered by the RAW first character being `!` (a space before it stays
  // an ordinary prompt) - mirrors `parseBangShell`, so the visual state and the submit routing agree.
  const shellMode = draft[0] === "!";

  // Auto-grow the textarea to fit multi-line prompts and quoted blocks, capped by its max-height
  // (then it scrolls). Reset to "auto" first so it also shrinks back down. `draft` drives the
  // content whose height we re-measure.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the draft changes (inputRef is stable).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  return (
    <>
      {uploadError ? (
        <div className="mb-2 flex items-center gap-2 text-label tracking-wider text-smui-red">
          <span>⚠ {uploadError}</span>
          <button
            type="button"
            onClick={() => setUploadError(null)}
            className="cursor-pointer text-muted-foreground hover:text-foreground"
          >
            dismiss
          </button>
        </div>
      ) : null}

      {/* Pending attachments, shown as removable chips (image thumbnail or a file pill) above the
        input until the next prompt carries them. */}
      {attachments.length || uploading > 0 ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {attachments.map((ref) => (
            <span
              key={ref.hash}
              className="inline-flex items-center gap-1.5 border border-border bg-card px-1.5 py-1 text-xs"
            >
              <ArtifactThumb artifact={ref} size={28} square />
              {ref.kind === "image" ? (
                <span className="max-w-[140px] truncate">{ref.name ?? ref.kind}</span>
              ) : null}
              <button
                type="button"
                onClick={() => removeAttachment(ref.hash)}
                title="Remove"
                className="cursor-pointer text-muted-foreground hover:text-smui-red"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {uploading > 0 ? (
            <span className="text-label tracking-wider text-muted-foreground">
              uploading {uploading}…
            </span>
          ) : null}
        </div>
      ) : null}

      <form onSubmit={onSubmit}>
        <div
          className={cn(
            "flex flex-col border bg-background transition-colors",
            shellMode
              ? "border-smui-orange/40 bg-smui-orange/[0.05] focus-within:border-smui-orange"
              : "border-input focus-within:border-ring",
          )}
        >
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={vim.onFocus}
            onKeyDown={(event) => {
              // Precedence: composer token-delete (D-092) first; then the Vim layer (in normal/visual it
              // consumes motions/edits + enters/leaves modes; in insert it only catches Escape, yielding
              // everything else); then App's handler (slash menu, Enter submit, Up/Down history).
              handleKeyDown(event);
              if (event.defaultPrevented) {
                return;
              }
              if (vim.onKeyDown(event)) {
                return;
              }
              onKeyDown(event);
            }}
            onPaste={onPaste}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className={cn(
              "max-h-48 w-full resize-none overflow-y-auto bg-transparent px-3 pt-2.5 pb-1.5 text-sm outline-none placeholder:text-muted-foreground/50 disabled:cursor-not-allowed",
              shellMode ? "font-mono text-smui-orange" : "text-foreground",
            )}
          />
          <div className="flex items-center gap-2 px-2 pb-2">
            <input ref={fileInputRef} type="file" multiple hidden onChange={onPickFiles} />
            {/* In shell mode the attach `+` is replaced in place by a shell glyph - same footprint, so
              the composer height never reflows when the leading `!` is typed. Shell is text-only, so
              dropping the attach control here also signals attachments aren't taken on this lane. */}
            {shellMode ? (
              <span
                role="img"
                aria-label="Shell command"
                title="Runs as a shell command on the host"
                className="flex size-7 items-center justify-center text-smui-orange"
              >
                <Terminal className="size-4.5" />
              </span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled}
                aria-label="Attach files (or paste / drag-drop)"
              >
                <Plus className="size-4.5" />
              </Button>
            )}
            {/* Expand the draft into the full-surface editor (02.12) for a larger writing area. */}
            {onExpand ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onExpand}
                disabled={disabled}
                aria-label="Expand prompt editor"
              >
                <Maximize2 className="size-4" />
              </Button>
            ) : null}
            {/* The Vim mode indicator sits at the right of the bottom row when Vim mode is on; its
              stable width keeps the row from reflowing as the mode changes. */}
            {vim.enabled ? (
              <>
                <span className="flex-1" />
                <VimModeIndicator mode={vim.mode} />
              </>
            ) : null}
          </div>
        </div>
        {/* Auto-growing textarea: Enter submits, Shift+Enter inserts a newline. */}
      </form>
    </>
  );
}
