import type { TangentFoldMode } from "@trevor/session";
import { ChevronDown, CornerUpLeft, GitBranch } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { MarkdownBody } from "@/components/chat/markdown-body";
import { BackToChat } from "@/components/panel/back-to-chat";
import { cn } from "@/lib/utils";

/**
 * A single tangent turn as the shell renders it: the tangent's OWN conversation, projected to a minimal
 * user/assistant shape (the tangent is a lightweight side thread, so it does not need the full transcript
 * row machinery). `streaming` marks an assistant turn still arriving.
 */
export interface TangentTurn {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming?: boolean;
}

/** Row-scoped feedback after a fold-back attempt (plan 37, M8): a visible success/error note. */
export interface FoldBackNote {
  readonly tone: "success" | "error";
  readonly text: string;
}

/** The scroll-follow wiring (plan 12.2) the live wrapper supplies; omitted in stories (plain scroll). */
export interface TangentScroll {
  readonly transcriptRef: RefObject<HTMLDivElement | null>;
  readonly onScroll: () => void;
  readonly atBottom: boolean;
  readonly onScrollToBottom: () => void;
  readonly onUserGesture: (direction: "up" | "down") => void;
}

export interface TangentShellProps {
  /** The selected snapshot the tangent branched from - the seed context header. */
  readonly sourceQuote: string;
  /** An optional label for where the tangent came from (e.g. the parent session title). */
  readonly parentLabel?: string;
  readonly turns: readonly TangentTurn[];
  /** A creation/transport error shown in place of the transcript (M4 error state). */
  readonly error?: string | null;
  /** True while a tangent turn is running: shows a working indicator and disables send. */
  readonly busy?: boolean;
  readonly composer: {
    readonly draft: string;
    readonly onDraftChange: (value: string) => void;
    readonly onSend: () => void;
    readonly disabled?: boolean;
    readonly placeholder?: string;
  };
  /**
   * Explicit fold-back (M8): when provided, each assistant turn gets a "Fold back to parent" affordance
   * that carries THAT turn's text toward the parent composer for review. It never auto-submits and never
   * injects hidden context - the shell only signals intent; the live wrapper places editable text in the
   * parent composer and records the durable marker.
   */
  readonly onFoldBack?: (content: { mode: TangentFoldMode; text: string }) => void;
  /** Row-scoped feedback after a fold-back (M8), e.g. "Sent to the parent composer for review". */
  readonly foldBackNote?: FoldBackNote | null;
  readonly onBack: () => void;
  readonly className?: string;
  readonly scroll?: TangentScroll;
}

/**
 * The tangent takeover shell (plan 37, M4): a center-column surface - NOT a modal - that replaces the
 * transcript/composer while the sidebars stay visible, mirroring the model-chooser / archive / tool-detail
 * takeovers (top-left back arrow, opaque column, Escape returns via the host's frontmost-surface guard).
 * It reads as a SEPARATE side conversation: a labelled source-quote header makes the seed context explicit,
 * the tangent's own turns render below, and its own composer sends into the tangent - never the parent.
 *
 * Purely presentational: the live wrapper owns the tangent session stream, composer state, and fold-back
 * wiring; stories drive every state (empty, seeded, active, completed, error, fold-back available, narrow)
 * against static props.
 */
export function TangentShell({
  sourceQuote,
  parentLabel,
  turns,
  error,
  busy,
  composer,
  onFoldBack,
  foldBackNote,
  onBack,
  className,
  scroll,
}: TangentShellProps) {
  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter keeps the newline (matching the main composer's plain-Enter send).
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!composer.disabled) {
        composer.onSend();
      }
    }
  };

  return (
    <section
      aria-label="Tangent"
      className={cn("@container flex min-h-0 flex-col bg-background text-foreground", className)}
    >
      <BackToChat onBack={onBack} />

      {/* Source context header: the selected snapshot the tangent branched from, clearly labelled so the
        takeover reads as a scoped side conversation rather than the parent chat. */}
      <div className="shrink-0 border-b border-border px-3 pb-3">
        <div className="flex items-center gap-1.5 text-label uppercase tracking-wider text-muted-foreground">
          <GitBranch className="size-3.5" />
          Tangent{parentLabel ? <span className="normal-case"> · from {parentLabel}</span> : null}
        </div>
        <blockquote className="mt-1.5 border-l-2 border-primary/60 bg-muted/40 py-1 pl-3 text-sm text-muted-foreground">
          {sourceQuote}
        </blockquote>
      </div>

      {/* Transcript well: the tangent's OWN turns. A creation error takes over this region. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scroll?.transcriptRef}
          onScroll={scroll?.onScroll}
          onWheel={(event) => {
            if (scroll && event.deltaY !== 0) {
              scroll.onUserGesture(event.deltaY < 0 ? "up" : "down");
            }
          }}
          data-tangent-transcript
          className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-4"
        >
          {error ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
              <p className="text-sm text-destructive">Couldn't open the tangent</p>
              <p className="text-xs text-muted-foreground">{error}</p>
            </div>
          ) : turns.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
              <p className="text-sm text-muted-foreground">A fresh tangent from your selection.</p>
              <p className="text-xs text-muted-foreground/70">
                Ask a question below - it stays isolated from the parent conversation.
              </p>
            </div>
          ) : (
            turns.map((turn) => (
              <TangentTurnRow key={turn.id} turn={turn} onFoldBack={onFoldBack} />
            ))
          )}
          {busy ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-primary" />
              Working in the tangent…
            </div>
          ) : null}
        </div>

        {scroll && !scroll.atBottom ? (
          <button
            type="button"
            onClick={scroll.onScrollToBottom}
            aria-label="Scroll to bottom"
            className="absolute bottom-3 left-1/2 z-10 flex size-8 -translate-x-1/2 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:text-foreground"
          >
            <ChevronDown className="size-4" />
          </button>
        ) : null}
      </div>

      {/* Fold-back feedback (M8): a visible, row-scoped note that content was placed in the parent
        composer for review - never a silent merge. */}
      {foldBackNote ? (
        <div
          className={cn(
            "shrink-0 px-3 py-2 text-xs",
            foldBackNote.tone === "success" ? "text-primary" : "text-destructive",
          )}
        >
          {foldBackNote.text}
        </div>
      ) : null}

      {/* The tangent's own composer: sends into the tangent session, never the parent. */}
      <div className="shrink-0 border-t border-border px-3 py-3">
        <textarea
          value={composer.draft}
          onChange={(event) => composer.onDraftChange(event.target.value)}
          onKeyDown={onComposerKeyDown}
          disabled={composer.disabled}
          rows={2}
          placeholder={composer.placeholder ?? "Ask in this tangent…"}
          className="w-full resize-none rounded-md border border-border bg-background p-2 text-sm text-foreground outline-none focus:border-primary/60 disabled:opacity-50"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={composer.onSend}
            disabled={composer.disabled}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </section>
  );
}

/** One tangent turn row: user prompts right-aligned, assistant replies as markdown with an optional
 *  explicit fold-back affordance (M8). */
function TangentTurnRow({
  turn,
  onFoldBack,
}: {
  turn: TangentTurn;
  onFoldBack?: (content: { mode: TangentFoldMode; text: string }) => void;
}) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
          {turn.text}
        </div>
      </div>
    );
  }
  return (
    <div className="group flex flex-col gap-1">
      <MarkdownBody text={turn.text} />
      {onFoldBack && !turn.streaming && turn.text.trim() ? (
        <button
          type="button"
          onClick={() => onFoldBack({ mode: "message", text: turn.text })}
          title="Send this reply to the parent composer for review"
          className="inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
        >
          <CornerUpLeft className="size-3.5" />
          Fold back to parent
        </button>
      ) : null}
    </div>
  );
}
