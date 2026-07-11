import type { ModelRef, QuickPickerGroup } from "@trevor/session";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { SplitModelControl } from "@/components/chooser/split-model-control";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The model + reasoning controls that ride at the bottom of the composer (the PromptInput footer row),
 * moved out of the SidePanel so the active selection sits next to the input it applies to. The model
 * row reuses the D-065 {@link SplitModelControl} (open-chooser left region + quick-picker chevron); the
 * reasoning control collapses to a single button showing the selected level, with the full list behind
 * a popover - the newer models expose many levels (off/minimal/low/medium/high/xhigh/max), too many to
 * lay out inline. Pure presentation over the selection state; App owns persistence + the chooser.
 */
export interface ComposerControlsConfig {
  readonly model: {
    /** The active model's display label, shown in the split control's left region. */
    readonly activeLabel: string;
    /** The recently-used models, grouped by source, for the quick picker. */
    readonly quickGroups: readonly QuickPickerGroup[];
    readonly sourceLabels?: Readonly<Record<string, string>>;
    readonly modelLabels?: Readonly<Record<string, string>>;
    readonly activeModel?: ModelRef | null;
    /** Open the full model chooser (the larger left region). */
    readonly onOpenChooser: () => void;
    /** Pick a model from the quick picker - the same selection contract the full chooser uses. */
    readonly onSelectModel: (ref: ModelRef) => void;
  };
  readonly reasoning: {
    readonly levels: readonly string[];
    readonly selected: string;
    readonly onChange: (level: string) => void;
  };
}

/**
 * The reasoning control: a compact button showing the active level, opening a popover of every level
 * the model supports. Closes on select so a pick immediately reflects back into the trigger label.
 */
function ReasoningPicker({ levels, selected, onChange }: ComposerControlsConfig["reasoning"]) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Reasoning: ${selected}`}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1.5 transition-colors hover:bg-card/60"
        >
          <span className="text-label tracking-wider uppercase text-muted-foreground">
            reasoning
          </span>
          <span className="text-sm lowercase">{selected}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-36 p-1">
        <div className="flex flex-col">
          {levels.map((level) => {
            const active = level === selected;
            return (
              <button
                key={level}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  onChange(level);
                  setOpen(false);
                }}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm lowercase transition-colors",
                  active ? "bg-primary/10 text-foreground" : "hover:bg-card",
                )}
              >
                <span>{level}</span>
                {active ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ComposerControls({ config }: { readonly config: ComposerControlsConfig }) {
  const { model, reasoning } = config;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <SplitModelControl
        activeLabel={model.activeLabel}
        quickGroups={model.quickGroups}
        sourceLabels={model.sourceLabels}
        modelLabels={model.modelLabels}
        activeModel={model.activeModel}
        onOpenChooser={model.onOpenChooser}
        onSelectModel={model.onSelectModel}
        className="max-w-56"
      />
      {reasoning.levels.length > 0 ? (
        <ReasoningPicker
          levels={reasoning.levels}
          selected={reasoning.selected}
          onChange={reasoning.onChange}
        />
      ) : null}
    </div>
  );
}
