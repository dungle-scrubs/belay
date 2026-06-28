import type { ModelRef, QuickPickerGroup } from "@trevor/session";
import { SplitModelControl } from "@/components/chooser/split-model-control";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/**
 * The model + reasoning + show-thinking controls that ride in the SidePanel (its `controls` slot).
 * The model row is the D-065 split control: a larger left region that opens the full chooser (a
 * takeover) and a right chevron that opens the small categorized quick picker of recent models. Pure
 * presentation over the selection state; App owns the persistence and the chooser open/close.
 */
export interface ControlsPanelConfig {
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
  readonly thinking: {
    readonly show: boolean;
    readonly onShowChange: (on: boolean) => void;
  };
}

export function ControlsPanel({ config }: { readonly config: ControlsPanelConfig }) {
  const { model, reasoning, thinking } = config;

  return (
    <>
      <SplitModelControl
        activeLabel={model.activeLabel}
        quickGroups={model.quickGroups}
        sourceLabels={model.sourceLabels}
        modelLabels={model.modelLabels}
        activeModel={model.activeModel}
        onOpenChooser={model.onOpenChooser}
        onSelectModel={model.onSelectModel}
        className="w-full"
      />

      {reasoning.levels.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="text-label tracking-wider uppercase text-muted-foreground">
            reasoning
          </span>
          <ToggleGroup
            type="single"
            value={reasoning.selected}
            onValueChange={(next) => {
              if (next) {
                reasoning.onChange(next);
              }
            }}
            variant="outline"
            size="sm"
            className="shrink-0"
          >
            {reasoning.levels.map((level) => (
              <ToggleGroupItem
                key={level}
                value={level}
                className="h-6 px-2 text-label lowercase data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
              >
                {level}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      ) : null}

      <div className="flex items-center gap-1.5">
        <Checkbox
          id="show-thinking"
          checked={thinking.show}
          onCheckedChange={(checked) => thinking.onShowChange(checked === true)}
        />
        <Label
          htmlFor="show-thinking"
          className="cursor-pointer text-label tracking-wider uppercase text-muted-foreground"
        >
          show thinking
        </Label>
      </div>
    </>
  );
}
