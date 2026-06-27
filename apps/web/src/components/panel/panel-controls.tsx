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
export function PanelControls(props: {
  /** The active model's display label, shown in the split control's left region. */
  activeLabel: string;
  /** The recently-used models, grouped by source, for the quick picker. */
  quickGroups: readonly QuickPickerGroup[];
  sourceLabels?: Readonly<Record<string, string>>;
  modelLabels?: Readonly<Record<string, string>>;
  activeModel?: ModelRef | null;
  /** Open the full model chooser (the larger left region). */
  onOpenChooser: () => void;
  /** Pick a model from the quick picker - the same selection contract the full chooser uses. */
  onSelectModel: (ref: ModelRef) => void;
  reasoningLevels: readonly string[];
  reasoning: string;
  onReasoningChange: (level: string) => void;
  showThinking: boolean;
  onShowThinkingChange: (on: boolean) => void;
}) {
  const {
    activeLabel,
    quickGroups,
    sourceLabels,
    modelLabels,
    activeModel,
    onOpenChooser,
    onSelectModel,
    reasoningLevels,
    reasoning,
    onReasoningChange,
    showThinking,
    onShowThinkingChange,
  } = props;

  return (
    <>
      <SplitModelControl
        activeLabel={activeLabel}
        quickGroups={quickGroups}
        sourceLabels={sourceLabels}
        modelLabels={modelLabels}
        activeModel={activeModel}
        onOpenChooser={onOpenChooser}
        onSelectModel={onSelectModel}
        className="w-full"
      />

      {reasoningLevels.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="text-label tracking-wider uppercase text-muted-foreground">
            reasoning
          </span>
          <ToggleGroup
            type="single"
            value={reasoning}
            onValueChange={(next) => {
              if (next) {
                onReasoningChange(next);
              }
            }}
            variant="outline"
            size="sm"
            className="shrink-0"
          >
            {reasoningLevels.map((level) => (
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
          checked={showThinking}
          onCheckedChange={(checked) => onShowThinkingChange(checked === true)}
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
