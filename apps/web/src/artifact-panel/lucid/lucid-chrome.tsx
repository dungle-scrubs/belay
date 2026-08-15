import type { LucidAnchor, LucidReviewState } from "@belay/session";
import { describeLucidAnchor } from "@belay/session";
import { AlertTriangle, Check, MessageSquarePlus, RotateCw, Send, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  deliverableLucidAnnotations,
  type LucidPanelState,
  orphanedLucidAnnotations,
} from "./lucid-panel-state";

/**
 * The native Belay CHROME around a Lucid surface (plan 27, M7): the composer, the composed-but-unsent
 * queue, the orphan tray, the version indicator, and the review controls - all driven by the pure
 * {@link LucidPanelState} reducer. Presentational only (props in, callbacks out), so every M7 state
 * (drafting, queued, orphaned, review resolved, deferred version) is a jsdom + Storybook render with
 * no iframe. Distinct from the overlay (which lives ON the artifact); this chrome lives AROUND it, and
 * from the transcript (annotation state is never woven into message rendering).
 */

export interface LucidChromeProps {
  readonly state: LucidPanelState;
  /** The folded, already-DELIVERED review state from the session log (structured feedback the agent
   *  has seen), rendered as read-only history distinct from the pending queue. */
  readonly delivered: LucidReviewState | null;
  readonly onEditNote: (note: string) => void;
  readonly onCommit: () => void;
  readonly onDiscard: () => void;
  readonly onRemoveQueued: (annotationId: string) => void;
  readonly onDeliver: () => void;
  readonly onApplyVersion: () => void;
  readonly onResolve: () => void;
  readonly onReopen: () => void;
}

function anchorLabel(anchor: LucidAnchor): string {
  return describeLucidAnchor(anchor);
}

export function LucidChrome(props: LucidChromeProps) {
  const { state, delivered } = props;
  const deliverable = deliverableLucidAnnotations(state);
  const orphans = orphanedLucidAnnotations(state);
  const resolved = state.reviewStatus === "resolved";

  return (
    <section
      aria-label="Lucid review"
      data-lucid-review-status={state.reviewStatus}
      className="flex min-h-0 shrink-0 flex-col gap-3 border-border border-t bg-card/60 p-3 text-sm @container"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-label tracking-wider text-muted-foreground">
          review · v{state.version}
          {delivered ? ` · ${delivered.annotations.length} delivered` : ""}
        </span>
        {resolved ? (
          <span className="flex items-center gap-1 text-smui-green text-label tracking-wider">
            <Check className="size-3.5" /> approved
          </span>
        ) : null}
      </div>

      {/* M6: a newer version arrived while pending work existed - a non-blocking banner, never a
        silent yank of a composed card. */}
      {state.pendingVersion !== null ? (
        <div className="flex items-center justify-between gap-2 border border-smui-yellow/30 bg-smui-yellow/[0.06] px-2 py-1.5">
          <span className="text-foreground">
            version {state.pendingVersion} is ready. Reloading re-checks your notes.
          </span>
          <Button type="button" size="xs" variant="outline" onClick={props.onApplyVersion}>
            <RotateCw className="size-3.5" /> reload
          </Button>
        </div>
      ) : null}

      {/* The composer: a targeted draft becomes an addressed note. */}
      {state.draft ? (
        <div className="flex flex-col gap-2 border border-primary/40 bg-primary/[0.04] p-2">
          <div className="flex items-start gap-1.5 text-muted-foreground text-xs">
            <MessageSquarePlus className="mt-0.5 size-3.5 shrink-0 text-primary" />
            <span className="min-w-0">
              on {anchorLabel(state.draft.anchor)}
              {state.draft.snippet ? (
                <span className="mt-0.5 block truncate text-foreground">
                  “{state.draft.snippet}”
                </span>
              ) : null}
            </span>
          </div>
          <textarea
            aria-label="Annotation note"
            value={state.draft.note}
            onChange={(event) => props.onEditNote(event.target.value)}
            placeholder="What should change here?"
            rows={2}
            className="w-full resize-none border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
          />
          <div className="flex items-center justify-end gap-1.5">
            <Button type="button" size="xs" variant="ghost" onClick={props.onDiscard}>
              <X className="size-3.5" /> cancel
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={!state.draft.note.trim()}
              onClick={props.onCommit}
            >
              <Check className="size-3.5" /> add
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          Click an element or select text in the artifact to annotate it.
        </p>
      )}

      {/* The composed-but-unsent queue (deliverable). */}
      {deliverable.length > 0 ? (
        <ul className="flex flex-col gap-1.5" aria-label="Queued annotations">
          {deliverable.map((annotation) => (
            <li
              key={annotation.annotationId}
              className="flex items-start justify-between gap-2 border border-border bg-background px-2 py-1.5"
            >
              <div className="min-w-0">
                <span className="block truncate text-muted-foreground text-xs">
                  {anchorLabel(annotation.anchor)}
                </span>
                <span className="block truncate text-foreground">{annotation.note}</span>
              </div>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Remove annotation"
                onClick={() => props.onRemoveQueued(annotation.annotationId)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* M4/M6: the orphan tray - annotations whose anchor no longer resolves after a version swap. */}
      {orphans.length > 0 ? (
        <section
          aria-label="Orphaned annotations"
          className="flex flex-col gap-1.5 border border-smui-red/25 bg-smui-red/[0.05] p-2"
        >
          <span className="flex items-center gap-1 text-label tracking-wider text-smui-red">
            <AlertTriangle className="size-3.5" /> orphaned · {orphans.length}
          </span>
          {orphans.map((annotation) => (
            <div
              key={annotation.annotationId}
              className="flex items-start justify-between gap-2 text-xs"
            >
              <span className="min-w-0 truncate text-foreground">
                “{annotation.note}” (was on {anchorLabel(annotation.anchor)})
              </span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Dismiss orphaned annotation"
                onClick={() => props.onRemoveQueued(annotation.annotationId)}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </section>
      ) : null}

      {/* Controls: deliver the queue as structured feedback; approve / reopen the review. */}
      <div className="flex items-center justify-between gap-2 @[20rem]:flex-row flex-col">
        <Button
          type="button"
          size="xs"
          className="w-full @[20rem]:w-auto"
          disabled={deliverable.length === 0}
          onClick={props.onDeliver}
        >
          <Send className="size-3.5" /> send {deliverable.length || ""} to agent
        </Button>
        {resolved ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="w-full @[20rem]:w-auto"
            onClick={props.onReopen}
          >
            reopen review
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className={cn("w-full @[20rem]:w-auto")}
            onClick={props.onResolve}
          >
            <Check className="size-3.5" /> approve
          </Button>
        )}
      </div>
    </section>
  );
}
