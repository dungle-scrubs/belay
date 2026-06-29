import type {
  ProviderQuestionAnswer,
  ProviderQuestionChoice,
  ProviderQuestionContract,
  ProviderQuestionItem,
} from "@trevor/session";
import { Check } from "lucide-react";
import type * as React from "react";
import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  buildAnswer,
  draftErrors,
  type GroupDraft,
  initialDraft,
  selectCustom,
  setCustomText,
  setNotes,
  setReason,
  toggleChoice,
  toggleDefer,
} from "./view-model";

/**
 * The presentational ask_user question surface: it renders a pending model-asked decision (1..5
 * grouped questions with concrete choices, metadata, and ASCII previews) and captures the user's
 * answer. Built Storybook-first - it owns only local draft state and emits the wire answer through
 * `onAnswer`; it has NO host, transport, or session-event dependency, so the live wiring (projecting
 * a pending question off the session log and publishing the answer) layers on later (Phase 3).
 *
 * It is presentation over the SHARED view-model (./view-model): every selection/notes/reason/defer
 * edit goes through a pure reducer, and the submit button is gated by the SAME `validateAnswer` the
 * host enforces, so the UI can never produce an answer the host would reject. Model-provided text
 * (questions, choices, previews) is rendered as inert text - previews are `<pre>`, never HTML.
 */

/**
 * Moves keyboard focus to the surface's active target: the selected / first roving choice row
 * (`[data-qrow][tabindex="0"]`), falling back to the first field for a free-text question. The one
 * target both mount-focus and focus-on-return use, so arrow-key readiness is identical either way.
 */
function focusQuestionTarget(root: HTMLElement): void {
  const target =
    root.querySelector<HTMLElement>('[data-qrow][tabindex="0"]') ??
    root.querySelector<HTMLElement>("textarea, input");
  target?.focus();
}

// Filled (borderless) field: a surface fill instead of a box outline, so the surface stays
// border-light. The focus ring is the only outline, and only while focused.
const FIELD_CLASS =
  "w-full rounded-md bg-smui-surface-2 px-3 py-2 text-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50";

export interface QuestionSurfaceProps {
  readonly contract: ProviderQuestionContract;
  /** Receives the accept/decline answer. Decline is emitted by the "Decline" button. */
  readonly onAnswer: (answer: ProviderQuestionAnswer) => void;
  /** The run ended before the user answered: render read-only and disable every control (AQ003). */
  readonly expired?: boolean;
  /** Heading above the group; defaults to a generic prompt. */
  readonly title?: string;
  readonly className?: string;
}

export function QuestionSurface({
  contract,
  onAnswer,
  expired,
  title,
  className,
}: QuestionSurfaceProps) {
  const [draft, setDraft] = useState<GroupDraft>(() => initialDraft(contract));
  const grouped = contract.questions.length > 1;
  const errors = draftErrors(contract, draft);
  const ready = errors.length === 0 && !expired;
  const sectionRef = useRef<HTMLElement>(null);

  const submit = () => {
    if (ready) {
      onAnswer(buildAnswer(contract, draft));
    }
  };

  // Move keyboard focus into the surface as soon as a question appears, so arrow keys navigate the
  // choices and Enter submits without a click first. The surface replaces the composer while a
  // question is pending, so there is nothing else competing for focus. Skip when expired, since the
  // surface is read-only then.
  useEffect(() => {
    if (expired) {
      return;
    }
    if (sectionRef.current) {
      focusQuestionTarget(sectionRef.current);
    }
  }, [expired]);

  // Restore keyboard focus when the tab/window regains focus or becomes visible again, so ArrowUp/
  // ArrowDown work immediately on return without a click (D-001). Returning to the tab can leave focus
  // on document.body (the composer that App would refocus is unmounted while a question is up), so the
  // surface restores its own. Conservative: never steal focus from a field the user is typing in
  // INSIDE the surface (notes, required reason, free-text, custom answer) - only restore when focus
  // has landed outside the surface. Inert while expired (read-only). <!-- D-004 -->
  useEffect(() => {
    if (expired) {
      return;
    }
    const restore = () => {
      const root = sectionRef.current;
      if (!root || document.hidden) {
        return;
      }
      if (root.contains(document.activeElement)) {
        return;
      }
      focusQuestionTarget(root);
    };
    window.addEventListener("focus", restore);
    document.addEventListener("visibilitychange", restore);
    return () => {
      window.removeEventListener("focus", restore);
      document.removeEventListener("visibilitychange", restore);
    };
  }, [expired]);

  return (
    <section
      ref={sectionRef}
      aria-label={title ?? "Question from Trevor"}
      className={cn(
        "flex w-full flex-col gap-4 rounded-xl bg-card p-4 text-foreground shadow-sm",
        className,
      )}
      onKeyDown={(e) => {
        if (e.key !== "Enter") {
          return;
        }
        // Enter submits the answer. Inside a textarea (notes / required reason / free-text answer)
        // plain Enter stays a newline and only Cmd/Ctrl+Enter submits; everywhere else (choice rows,
        // the single-line custom-answer input) plain Enter submits. Shift+Enter never submits.
        const inTextarea = (e.target as HTMLElement).tagName === "TEXTAREA";
        if (e.metaKey || e.ctrlKey || (!inTextarea && !e.shiftKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">{title ?? "Trevor needs your input"}</h2>
        {grouped ? (
          <p className="text-xs text-muted-foreground">
            {contract.questions.length} questions - answer each to continue.
          </p>
        ) : null}
      </header>

      {expired ? (
        <p
          role="status"
          className="rounded-md bg-smui-surface-2 px-3 py-2 text-xs text-muted-foreground"
        >
          This question expired - the run ended before it was answered.
        </p>
      ) : null}

      <ol className="flex flex-col gap-5">
        {contract.questions.map((q, i) => (
          <li key={q.id}>
            <QuestionCard
              question={q}
              index={i + 1}
              grouped={grouped}
              draft={draft}
              disabled={expired === true}
              onChange={setDraft}
            />
          </li>
        ))}
      </ol>

      <footer className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={expired === true}
          onClick={() => onAnswer({ action: "decline" })}
        >
          Decline
        </Button>
        <Button type="button" size="sm" disabled={!ready} onClick={submit}>
          {grouped ? "Submit answers" : "Submit answer"}
        </Button>
      </footer>
    </section>
  );
}

/** One question: optional header + index, the prompt, its choices/custom/free-text, notes, reason, defer. */
function QuestionCard({
  question: q,
  index,
  grouped,
  draft,
  disabled,
  onChange,
}: {
  question: ProviderQuestionItem;
  index: number;
  grouped: boolean;
  draft: GroupDraft;
  disabled: boolean;
  onChange: (next: GroupDraft) => void;
}) {
  const d = draft.byId[q.id];
  const deferred = d?.deferred ?? false;
  const inert = disabled || deferred;
  const reasonId = useId();
  const notesId = useId();
  const [showNotes, setShowNotes] = useState(false);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Reveal-and-focus the note in one step, whether opened by the button or the "n" accelerator. Drop the
  // caret at the END so reopening a saved note continues where the user left off instead of at the start.
  useEffect(() => {
    if (showNotes) {
      const el = notesRef.current;
      if (el) {
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
      }
    }
  }, [showNotes]);

  // Collapse the note (its text is kept in the draft, so reopening with "n" restores it) and return
  // focus to the choice group so arrow keys resume scrolling choices.
  const collapseNote = () => {
    setShowNotes(false);
    cardRef.current?.querySelector<HTMLElement>('[data-qrow][tabindex="0"]')?.focus();
  };

  return (
    // Questions stay flush with the card heading + footer; the surface fill lives on each answer row,
    // not a per-question wrapper block (which only added indentation).
    // biome-ignore lint/a11y/noStaticElementInteractions: the card only captures the "n" note accelerator; every control stays independently operable.
    <div
      ref={cardRef}
      className="flex flex-col gap-2"
      onKeyDown={(e) => {
        // "n" opens + focuses the note, unless the user is typing in a field.
        const tag = (e.target as HTMLElement).tagName;
        if (e.key === "n" && !showNotes && !inert && tag !== "INPUT" && tag !== "TEXTAREA") {
          e.preventDefault();
          setShowNotes(true);
        }
      }}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        {q.header ? (
          <span className="text-label tracking-wider text-muted-foreground uppercase">
            {q.header}
          </span>
        ) : null}
        <p className="text-sm font-medium">
          {grouped ? <span className="text-muted-foreground">{index}. </span> : null}
          {q.question}
        </p>
      </div>

      <div className={cn("flex flex-col gap-1.5", inert && "opacity-50")}>
        {q.answerShape === "free_text" ? (
          <textarea
            aria-label={q.question}
            rows={3}
            disabled={inert}
            value={d?.customText ?? ""}
            onChange={(e) => onChange(setCustomText(draft, q, e.target.value))}
            placeholder="Type your answer"
            className={FIELD_CLASS}
          />
        ) : (
          <ChoiceList question={q} draft={draft} disabled={inert} onChange={onChange} />
        )}

        {/* Required reason: always visible and marked required so submit stays gated until filled. */}
        {q.requiresReason ? (
          <label htmlFor={reasonId} className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>
              Reason <span className="text-destructive">*</span>
            </span>
            <textarea
              id={reasonId}
              rows={2}
              disabled={inert}
              value={d?.reason ?? ""}
              onChange={(e) => onChange(setReason(draft, q.id, e.target.value))}
              placeholder="Why this choice?"
              className={FIELD_CLASS}
            />
          </label>
        ) : null}

        {/* Optional notes, revealed on demand to keep the surface compact. */}
        {showNotes ? (
          <label htmlFor={notesId} className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>Notes (optional)</span>
            <textarea
              ref={notesRef}
              id={notesId}
              rows={2}
              disabled={inert}
              value={d?.notes ?? ""}
              onChange={(e) => onChange(setNotes(draft, q.id, e.target.value))}
              onKeyDown={(e) => {
                // Esc collapses the note (text is kept); arrow keys stay default cursor movement.
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  collapseNote();
                }
              }}
              placeholder="Anything to add?"
              className={FIELD_CLASS}
            />
          </label>
        ) : (
          <button
            type="button"
            disabled={inert}
            onClick={() => setShowNotes(true)}
            className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
          >
            + Add a <span className="underline">n</span>ote
          </button>
        )}
      </div>

      {q.allowDefer ? (
        <button
          type="button"
          aria-pressed={deferred}
          disabled={disabled}
          onClick={() => onChange(toggleDefer(draft, q.id))}
          className={cn(
            "self-start text-xs underline-offset-2 hover:underline",
            deferred ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {deferred ? "Deferred - tap to answer instead" : "Skip this for now"}
        </button>
      ) : null}
    </div>
  );
}

/** Only the selected radio (or the first when none is picked) is tabbable; multi-select rows all are. */
function tabIndexFor(
  q: ProviderQuestionItem,
  selected: readonly string[],
  customSelected: boolean,
  index: number,
): number {
  if (q.multiSelect) {
    return 0;
  }
  const customIndex = q.choices.length;
  if (index === customIndex) {
    // The custom row is reachable by arrow even when not the tab-stop; it only Tab-stops when chosen.
    return customSelected ? 0 : -1;
  }
  if (customSelected) {
    return -1;
  }
  return selected.includes(q.choices[index]?.id ?? "") || (selected.length === 0 && index === 0)
    ? 0
    : -1;
}

/**
 * The single-choice ARIA radio keyboard pattern, extended to include the custom-answer row as the LAST
 * navigable item. Arrow keys move selection AND DOM focus across the choices and the custom input (so the
 * roving tab-stop follows). In the custom input, Left/Right/Home/End edit text instead of navigating.
 * Multi-select rows are plain toggles, so they keep the browser's default Tab/Space behavior.
 */
function makeChoiceNav(
  q: ProviderQuestionItem,
  draft: GroupDraft,
  onChange: (next: GroupDraft) => void,
) {
  const customIndex = q.choices.length;
  return (e: React.KeyboardEvent, current: number) => {
    if (q.multiSelect) {
      return;
    }
    const inCustomInput = current === customIndex;
    const keys = inCustomInput
      ? ["ArrowDown", "ArrowUp"]
      : ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
    if (!keys.includes(e.key)) {
      return;
    }
    e.preventDefault();
    const last = customIndex; // the custom row is the final navigable item
    const target =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? last
          : e.key === "ArrowDown" || e.key === "ArrowRight"
            ? Math.min(current + 1, last)
            : Math.max(current - 1, 0);
    if (target === current) {
      return;
    }
    if (target < customIndex) {
      const c = q.choices[target];
      if (c) {
        onChange(toggleChoice(draft, q, c.id));
      }
    } else {
      onChange(selectCustom(draft, q));
    }
    const group = e.currentTarget.closest("[data-qgroup]");
    group?.querySelector<HTMLElement>(`[data-qrow="${target}"]`)?.focus();
  };
}

/**
 * Choices for a single-/multi-select question. When the choices carry visualizations (a `preview`, or
 * `kind === "preview"`) it uses the master-detail split (`SplitChoiceList`); otherwise the plain
 * stacked rows. Both render the choices plus the custom-answer row as one navigable group.
 */
function ChoiceList(props: {
  question: ProviderQuestionItem;
  draft: GroupDraft;
  disabled: boolean;
  onChange: (next: GroupDraft) => void;
}) {
  const previewish =
    props.question.kind === "preview" || props.question.choices.some((c) => c.preview != null);
  return previewish ? <SplitChoiceList {...props} /> : <PlainChoiceList {...props} />;
}

/**
 * The choices + custom-answer row as one keyboard group. The custom row is the LAST item, so arrowing
 * past the final choice lands on its inline text input. `onActivate`/`activeId` (split layout only) let
 * the right preview pane track the highlighted choice.
 */
function ChoiceColumn({
  question: q,
  draft,
  disabled,
  onChange,
  activeId,
  onActivate,
  inlinePreviewClassName,
}: {
  question: ProviderQuestionItem;
  draft: GroupDraft;
  disabled: boolean;
  onChange: (next: GroupDraft) => void;
  activeId?: string;
  onActivate?: (id: string) => void;
  inlinePreviewClassName?: string;
}) {
  const d = draft.byId[q.id];
  const selected = d?.selectedIds ?? [];
  const customSelected = d?.customSelected ?? false;
  const nav = makeChoiceNav(q, draft, onChange);
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label is valid on both roles; the ternary role defeats static analysis.
    <div
      data-qgroup
      role={q.multiSelect ? "group" : "radiogroup"}
      aria-label={q.question}
      className="flex min-w-0 flex-col gap-1.5"
    >
      {q.choices.map((c, i) => (
        <ChoiceRow
          key={c.id}
          choice={c}
          index={i}
          role={q.multiSelect ? "checkbox" : "radio"}
          selected={selected.includes(c.id)}
          active={activeId === undefined ? undefined : c.id === activeId}
          disabled={disabled}
          tabIndex={tabIndexFor(q, selected, customSelected, i)}
          onSelect={() => {
            onChange(toggleChoice(draft, q, c.id));
            onActivate?.(c.id);
          }}
          onActivate={() => onActivate?.(c.id)}
          onKeyNav={(e) => nav(e, i)}
          inlinePreviewClassName={inlinePreviewClassName}
        />
      ))}
      <CustomRow
        question={q}
        index={q.choices.length}
        draft={draft}
        disabled={disabled}
        tabIndex={tabIndexFor(q, selected, customSelected, q.choices.length)}
        onChange={onChange}
        onActivate={() => onActivate?.("")}
        onKeyNav={(e) => nav(e, q.choices.length)}
      />
    </div>
  );
}

/** The plain stacked layout: each choice row carries its own preview inline beneath it. */
function PlainChoiceList(props: {
  question: ProviderQuestionItem;
  draft: GroupDraft;
  disabled: boolean;
  onChange: (next: GroupDraft) => void;
}) {
  return <ChoiceColumn {...props} />;
}

/**
 * The master-detail layout for visualization-bearing questions. On a wide enough container the options
 * list on the LEFT and a single preview shows on the RIGHT, tracking the highlighted option - arrow/Tab/
 * hover through the list and the right pane swaps to that option's visualization, so only one shows at a
 * time. On a narrow container (side panel / mobile) it collapses to the stacked layout with each option's
 * preview inline. The split threshold is a CONTAINER query, so it follows the surface's real width.
 */
function SplitChoiceList(props: {
  question: ProviderQuestionItem;
  draft: GroupDraft;
  disabled: boolean;
  onChange: (next: GroupDraft) => void;
}) {
  const q = props.question;
  // The right pane defaults to the recommended choice (or the first) and then follows focus/selection.
  const fallback = q.choices.find((c) => c.recommended) ?? q.choices[0];
  const [activeId, setActiveId] = useState(fallback?.id ?? "");

  return (
    // The @container must be an ANCESTOR of the grid - a container-query element can't size ITSELF by
    // its own width, only its descendants can.
    <div className="@container">
      <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 @lg:grid-cols-2 @lg:items-start">
        <ChoiceColumn
          {...props}
          activeId={activeId}
          onActivate={setActiveId}
          inlinePreviewClassName="@lg:hidden"
        />
        <PreviewPane choices={q.choices} activeId={activeId} />
      </div>
    </div>
  );
}

/**
 * The detail pane: every option's preview stacked into ONE grid cell so the pane is always sized to the
 * TALLEST preview and its height never changes as you highlight a different option (no vertical reflow);
 * only the active one is visible. Wide layout only - the inline previews cover the narrow layout.
 */
function PreviewPane({
  choices,
  activeId,
}: {
  choices: readonly ProviderQuestionChoice[];
  activeId: string;
}) {
  const withPreview = choices.filter((c) => c.preview != null);
  if (withPreview.length === 0) {
    return <div className="hidden @lg:block" />;
  }
  return (
    <div className="hidden min-w-0 @lg:grid">
      {withPreview.map((c) => (
        <figure
          key={c.id}
          aria-hidden={c.id !== activeId}
          className="m-0 flex flex-col gap-1 [grid-area:1/1]"
          style={{ visibility: c.id === activeId ? "visible" : "hidden" }}
        >
          {c.preview ? <ChoicePreview preview={c.preview} className="mt-0" /> : null}
          <figcaption className="text-xs text-muted-foreground">{c.label}</figcaption>
        </figure>
      ))}
    </div>
  );
}

/** The custom-answer row: a radio/checkbox indicator + an inline text input, navigable as the last item. */
function CustomRow({
  question: q,
  index,
  draft,
  disabled,
  tabIndex,
  onChange,
  onActivate,
  onKeyNav,
}: {
  question: ProviderQuestionItem;
  index: number;
  draft: GroupDraft;
  disabled: boolean;
  tabIndex: number;
  onChange: (next: GroupDraft) => void;
  onActivate?: () => void;
  onKeyNav: (e: React.KeyboardEvent) => void;
}) {
  const d = draft.byId[q.id];
  const customSelected = d?.customSelected ?? false;
  return (
    // A label so a click anywhere in the row focuses the input natively (no extra click handler).
    <label
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-3 py-2 transition-colors",
        customSelected ? "bg-primary/15" : "bg-smui-surface-2 hover:bg-smui-surface-3",
        disabled && "opacity-50",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center border",
          q.multiSelect ? "rounded-[4px]" : "rounded-full",
          customSelected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/40",
        )}
      >
        {customSelected ? <Check className="size-3" /> : null}
      </span>
      <input
        type="text"
        data-qrow={index}
        tabIndex={tabIndex}
        aria-label={`Custom answer for: ${q.question}`}
        disabled={disabled}
        value={d?.customText ?? ""}
        onChange={(e) => onChange(setCustomText(draft, q, e.target.value))}
        onFocus={() => {
          if (!customSelected) {
            onChange(selectCustom(draft, q));
          }
          onActivate?.();
        }}
        onKeyDown={onKeyNav}
        placeholder={q.multiSelect ? "Add your own option" : "Or enter your own answer"}
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
      />
    </label>
  );
}

/** One choice row: a clickable card with a radio/checkbox indicator, label, description, metadata, preview. */
function ChoiceRow({
  choice: c,
  index,
  role,
  selected,
  active,
  disabled,
  tabIndex,
  onSelect,
  onActivate,
  onKeyNav,
  inlinePreviewClassName,
}: {
  choice: ProviderQuestionChoice;
  index: number;
  role: "radio" | "checkbox";
  selected: boolean;
  /** Highlighted as the choice whose preview shows in the detail pane (split layout). */
  active?: boolean;
  disabled: boolean;
  tabIndex: number;
  onSelect: () => void;
  /** Fired when the row becomes the focused/hovered one, so the detail pane can track it. */
  onActivate?: () => void;
  onKeyNav: (e: React.KeyboardEvent) => void;
  /** Extra classes for the inline preview (used to hide it on the wide split layout). */
  inlinePreviewClassName?: string;
}) {
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-checked is valid for radio/checkbox; the ternary role defeats static analysis.
    <button
      type="button"
      role={role}
      data-qrow={index}
      aria-checked={selected}
      disabled={disabled}
      tabIndex={tabIndex}
      onClick={onSelect}
      onFocus={onActivate}
      onMouseEnter={onActivate}
      onKeyDown={onKeyNav}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md px-3 py-2 text-left transition-colors disabled:opacity-50",
        selected
          ? "bg-primary/15"
          : active
            ? "bg-smui-surface-3"
            : "bg-smui-surface-2 hover:bg-smui-surface-3",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
          role === "radio" ? "rounded-full" : "rounded-[4px]",
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/40",
        )}
      >
        {selected ? <Check className="size-3" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{c.label}</span>
          {c.recommended ? (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              Recommended
            </Badge>
          ) : null}
          {(c.badges ?? []).map((b) => (
            <Badge key={b} variant="outline" className="px-1.5 py-0 text-[10px]">
              {b}
            </Badge>
          ))}
        </span>
        {c.description ? (
          <span className="text-xs text-muted-foreground">{c.description}</span>
        ) : null}
        {c.impact ? (
          <span className="text-xs text-muted-foreground">
            <span className="text-foreground/70">Impact:</span> {c.impact}
          </span>
        ) : null}
        {c.risk ? (
          <span className="text-xs text-[hsl(var(--smui-orange))]">
            <span className="font-medium">Risk:</span> {c.risk}
          </span>
        ) : null}
        {c.preview ? (
          <ChoicePreview preview={c.preview} className={inlinePreviewClassName} />
        ) : null}
      </span>
    </button>
  );
}

/** A choice's ASCII preview, rendered as inert preformatted text (never interpreted as HTML). */
function ChoicePreview({
  preview,
  className,
}: {
  preview: NonNullable<ProviderQuestionChoice["preview"]>;
  className?: string;
}) {
  const body = [preview.before, preview.text, preview.after]
    .filter((s) => s != null && s.length > 0)
    .join("\n");
  if (body.length === 0) {
    return null;
  }
  return (
    <pre
      className={cn(
        "mt-1 overflow-x-auto rounded bg-smui-surface-sunken p-2 text-[11px] leading-snug text-muted-foreground",
        className,
      )}
    >
      {preview.viewport ? (
        <span className="mb-1 block text-label text-muted-foreground/70">{preview.viewport}</span>
      ) : null}
      {body}
    </pre>
  );
}
