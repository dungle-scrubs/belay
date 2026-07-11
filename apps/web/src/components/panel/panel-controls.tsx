import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

/**
 * The show-thinking + compact display toggles that ride in the SidePanel (its `controls` slot). The
 * model + reasoning selection moved to the composer footer ({@link ComposerControls}), next to the
 * input it applies to; this panel keeps only the transcript display toggles. Pure presentation over
 * the selection state; App owns the persistence.
 */
export interface ControlsPanelConfig {
  readonly thinking: {
    readonly show: boolean;
    readonly onShowChange: (on: boolean) => void;
  };
  /** Compact transcript layout (plan 05): collapse non-primary rows to one line. */
  readonly compact: {
    readonly show: boolean;
    readonly onShowChange: (on: boolean) => void;
  };
}

/** A `Checkbox` + `Label` display toggle - the shared shape for the show-thinking + compact controls. */
function LabeledCheckbox({
  id,
  checked,
  onChange,
  label,
}: {
  readonly id: string;
  readonly checked: boolean;
  readonly onChange: (on: boolean) => void;
  readonly label: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <Label
        htmlFor={id}
        className="cursor-pointer text-label tracking-wider uppercase text-muted-foreground"
      >
        {label}
      </Label>
    </div>
  );
}

export function ControlsPanel({ config }: { readonly config: ControlsPanelConfig }) {
  const { thinking, compact } = config;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <LabeledCheckbox
        id="show-thinking"
        checked={thinking.show}
        onChange={thinking.onShowChange}
        label="show thinking"
      />
      <LabeledCheckbox
        id="compact-layout"
        checked={compact.show}
        onChange={compact.onShowChange}
        label="compact"
      />
    </div>
  );
}
