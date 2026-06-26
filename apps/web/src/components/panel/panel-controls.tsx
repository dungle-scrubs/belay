import { ModelSelector } from "@/components/assistant-ui/model-selector";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/** One pickable model in the selector (id + display name, optionally grouped local/cloud). */
export interface ModelOption {
  readonly id: string;
  readonly name: string;
  readonly group?: string;
}

/**
 * The model + reasoning + show-thinking controls that ride in the SidePanel (its `controls` slot).
 * Pure presentation over the selection state: the picked model, the model's available reasoning levels
 * + current pick, and the show-thinking toggle. App owns the state and persistence; this owns the row,
 * so the App shell is no longer the place that assembles the controls markup.
 */
export function PanelControls(props: {
  models: readonly ModelOption[];
  activeProvider: string;
  onProviderChange: (id: string) => void;
  reasoningLevels: readonly string[];
  reasoning: string;
  onReasoningChange: (level: string) => void;
  showThinking: boolean;
  onShowThinkingChange: (on: boolean) => void;
}) {
  const {
    models,
    activeProvider,
    onProviderChange,
    reasoningLevels,
    reasoning,
    onReasoningChange,
    showThinking,
    onShowThinkingChange,
  } = props;

  return (
    <>
      <ModelSelector.Root models={models} value={activeProvider} onValueChange={onProviderChange}>
        <ModelSelector.Trigger className="w-full justify-between text-label" />
        <ModelSelector.Content>
          <ModelSelector.Search />
          <ModelSelector.List />
        </ModelSelector.Content>
      </ModelSelector.Root>

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
