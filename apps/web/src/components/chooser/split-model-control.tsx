import { type ModelRef, modelRefKey, type QuickPickerGroup, sameModel } from "@belay/session";
import { Check, ChevronDown, Sparkles } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The sidebar active-model SPLIT control (D-065 M3): the current sidebar model select becomes two
 * regions divided by a visible vertical rule. The larger LEFT region opens the full {@link ModelChooser}
 * (the takeover surface); the right CHEVRON region opens a small categorized quick picker of
 * RECENTLY-USED models only (never the full catalog). Both regions are `cursor-pointer`. Selecting from
 * the quick picker uses the SAME `ModelRef` contract as the full chooser, so the two never diverge.
 *
 * Presentational over the host-owned read models: the active label + the quick-picker groups
 * (`quickPickerModels(prefs)`) come from props; the two actions are callbacks the App wires.
 */

export interface SplitModelControlProps {
  /** The active model's display label, shown in the larger left region. */
  readonly activeLabel: string;
  /** The categorized recent-model groups (from `quickPickerModels`), newest-first within each source. */
  readonly quickGroups: readonly QuickPickerGroup[];
  /** Optional source-id -> display label map for the quick-picker group headers. */
  readonly sourceLabels?: Readonly<Record<string, string>>;
  /** Optional model-id -> display label map for the quick-picker rows (falls back to the model id). */
  readonly modelLabels?: Readonly<Record<string, string>>;
  readonly activeModel?: ModelRef | null;
  /** Open the full model chooser (the larger left region). */
  readonly onOpenChooser: () => void;
  /** Pick a model from the quick picker - the same selection contract the full chooser uses. */
  readonly onSelectModel: (ref: ModelRef) => void;
  readonly className?: string;
}

export function SplitModelControl({
  activeLabel,
  quickGroups,
  sourceLabels,
  modelLabels,
  activeModel,
  onOpenChooser,
  onSelectModel,
  className,
}: SplitModelControlProps) {
  return (
    <div
      className={cn(
        "flex items-stretch overflow-hidden rounded-md border border-border bg-card",
        className,
      )}
    >
      {/* The larger left region: opens the full chooser. */}
      <button
        type="button"
        onClick={onOpenChooser}
        aria-label="Open model chooser"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-1.5 py-1 text-left transition-colors hover:bg-card/60"
      >
        <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs">{activeLabel}</span>
      </button>

      {/* A visible vertical divider between the full-chooser region and the quick-picker chevron. */}
      <div aria-hidden className="w-px shrink-0 self-stretch bg-border" />

      {/* The right chevron region: opens the small categorized quick picker. */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Recent models"
            className="flex shrink-0 cursor-pointer items-center px-1.5 transition-colors hover:bg-card/60"
          >
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} className="w-64 p-1.5">
          <QuickPickerContent
            groups={quickGroups}
            sourceLabels={sourceLabels}
            modelLabels={modelLabels}
            activeModel={activeModel}
            onSelectModel={onSelectModel}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

interface QuickPickerContentProps {
  readonly groups: readonly QuickPickerGroup[];
  readonly sourceLabels?: Readonly<Record<string, string>>;
  readonly modelLabels?: Readonly<Record<string, string>>;
  readonly activeModel?: ModelRef | null;
  readonly onSelectModel: (ref: ModelRef) => void;
}

/**
 * The quick-picker popover body: the recently-used models, grouped by source and categorized with a
 * header per source. Small and bounded (the recent list is capped), never the full catalog.
 */
function QuickPickerContent({
  groups,
  sourceLabels,
  modelLabels,
  activeModel,
  onSelectModel,
}: QuickPickerContentProps) {
  if (groups.length === 0) {
    return (
      <p className="px-2 py-3 text-xs text-muted-foreground">
        No recent models yet. Open the full chooser to pick one.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {groups.map((group) => (
        <div key={group.sourceId} className="flex flex-col">
          <p className="px-2 py-1 text-label tracking-wider text-muted-foreground">
            {sourceLabels?.[group.sourceId] ?? group.sourceId}
          </p>
          {group.models.map((ref) => {
            const selected = activeModel != null && sameModel(activeModel, ref);
            return (
              <button
                key={modelRefKey(ref)}
                type="button"
                onClick={() => onSelectModel(ref)}
                aria-pressed={selected}
                aria-label={`Select ${modelLabels?.[ref.modelId] ?? ref.modelId}`}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm transition-colors",
                  selected ? "bg-primary/10 text-foreground" : "hover:bg-card",
                )}
              >
                <span className="truncate">{modelLabels?.[ref.modelId] ?? ref.modelId}</span>
                {selected ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
