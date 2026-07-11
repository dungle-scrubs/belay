import type { ModelRef, QuickPickerGroup, UsageBreakdown } from "@trevor/session";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { SplitModelControl } from "@/components/chooser/split-model-control";
import { panelBreakdown } from "@/components/panel/breakdown";
import { contextPressureState, type PressureBand } from "@/components/panel/context-pressure";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtTokens } from "@/derive";
import { useArmedAfterMount } from "@/hooks/use-armed-after-mount";
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
  /** The latest call's context usage + session breakdown, for the gauge and its hover tooltip. */
  readonly context: {
    /** Tokens consumed by the latest call (its input). */
    readonly ctxUsed?: number;
    /** Context-window size for the latest call (the maximum). */
    readonly ctxMax?: number;
    /** Session breakdown of what fills the current context window (the tooltip legend). */
    readonly breakdown?: UsageBreakdown;
    /** Total tokens across the session's current context window (the tooltip total). */
    readonly totalTokens?: number;
  };
}

// The gauge owns the band -> color mapping; the shared policy owns which band a ratio is in. Same
// semantic escalation as the side-panel meter (primary -> yellow -> orange -> destructive), so the
// ring, the tooltip's mini meter, and the panel all read the same pressure through color (D-001).
const GAUGE_STROKE: Record<PressureBand, string> = {
  normal: "stroke-primary",
  warning: "stroke-smui-yellow",
  danger: "stroke-smui-orange",
  critical: "stroke-destructive",
};

const BAND_FILL: Record<PressureBand, string> = {
  normal: "bg-primary",
  warning: "bg-smui-yellow",
  danger: "bg-smui-orange",
  critical: "bg-destructive",
};

const BAND_TEXT: Record<PressureBand, string> = {
  normal: "text-foreground",
  warning: "text-foreground",
  danger: "text-smui-orange",
  critical: "font-semibold text-destructive",
};

/**
 * The gauge's hover card: the context-window fill (a mini meter + the usage figure) plus the session
 * breakdown of what occupies that window (one legend row per category, biggest first). Reuses
 * {@link panelBreakdown} and the shared pressure policy so it never disagrees with the side panel.
 */
function ContextGaugeTooltip({
  pressure,
  ctxUsed,
  breakdown,
  totalTokens,
}: {
  readonly pressure: NonNullable<ReturnType<typeof contextPressureState>>;
  readonly ctxUsed: number | undefined;
  readonly breakdown: UsageBreakdown | undefined;
  readonly totalTokens: number | undefined;
}) {
  const bd = breakdown ? panelBreakdown(breakdown) : null;
  const rows = bd ? [...bd.leaves].sort((a, c) => c.value - a.value) : [];

  return (
    <div className="flex min-w-56 flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-6">
          <span className="text-label tracking-wider uppercase text-muted-foreground">
            context window
          </span>
          <span className={cn("text-sm tabular-nums", BAND_TEXT[pressure.band])}>
            {pressure.percent}%
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
          <div
            className={cn("h-full rounded-full", BAND_FILL[pressure.band])}
            style={{ width: `${pressure.clampedPercent}%` }}
          />
        </div>
        <div className="tabular-nums text-muted-foreground">
          {ctxUsed != null
            ? `${fmtTokens(ctxUsed)} of ${pressure.windowLabel}`
            : pressure.windowLabel}
        </div>
      </div>

      {rows.length > 0 && bd ? (
        <div className="flex flex-col gap-1 border-t border-border pt-2">
          <div className="flex items-baseline justify-between gap-6">
            <span className="text-label tracking-wider uppercase text-muted-foreground">
              session
            </span>
            {totalTokens != null ? (
              <span className="tabular-nums text-muted-foreground">
                {fmtTokens(totalTokens)} tok
              </span>
            ) : null}
          </div>
          <ul className="flex flex-col gap-1">
            {rows.map((leaf) => {
              const leafTokens =
                totalTokens != null && bd.total > 0
                  ? Math.round((leaf.value / bd.total) * totalTokens)
                  : null;
              const share = bd.total > 0 ? Math.round((leaf.value / bd.total) * 100) : 0;
              const shareLabel = share === 0 && leaf.value > 0 ? "<1%" : `${share}%`;
              return (
                <li key={leaf.key} className="flex items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-[2px]"
                    style={{ background: leaf.color }}
                  />
                  <span className="truncate text-foreground">{leaf.label}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                    {leafTokens != null ? `${fmtTokens(leafTokens)} · ${shareLabel}` : shareLabel}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A small circular context gauge: a full track ring with a semantic arc filled to the latest call's
 * context usage. Reuses {@link contextPressureState} for the ratio/band/label, so the gauge and the
 * side-panel meter never disagree. Hovering it opens a richer breakdown card. Renders nothing when
 * usage can't be derived.
 */
function ContextGauge({
  ctxUsed,
  ctxMax,
  breakdown,
  totalTokens,
}: ComposerControlsConfig["context"]) {
  const pressure = contextPressureState(ctxUsed, ctxMax);
  // Snap into place on first paint; only later usage changes sweep the arc.
  const armed = useArmedAfterMount(pressure != null);
  if (!pressure) {
    return null;
  }

  const size = 16;
  const stroke = 2.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pressure.clampedPercent / 100);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={pressure.ariaLabel}
          className="mx-1 flex shrink-0 items-center"
        >
          {/* The wrapping span owns the accessible name (role=img + aria-label); the SVG itself is
            decorative, so it is hidden from assistive tech. */}
          <svg
            aria-hidden="true"
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            fill="none"
            className="-rotate-90"
          >
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              strokeWidth={stroke}
              className="stroke-secondary"
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              className={cn(
                GAUGE_STROKE[pressure.band],
                armed
                  ? "transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
                  : undefined,
              )}
            />
          </svg>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" className="px-3 py-2">
        <ContextGaugeTooltip
          pressure={pressure}
          ctxUsed={ctxUsed}
          breakdown={breakdown}
          totalTokens={totalTokens}
        />
      </TooltipContent>
    </Tooltip>
  );
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
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-1.5 py-1 transition-colors hover:bg-card/60"
        >
          <span className="text-xs lowercase">{selected}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-36 p-1">
        <p className="px-2 py-1 text-label tracking-wider uppercase text-muted-foreground">
          reasoning
        </p>
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
  const { model, reasoning, context } = config;

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
      <ContextGauge
        ctxUsed={context.ctxUsed}
        ctxMax={context.ctxMax}
        breakdown={context.breakdown}
        totalTokens={context.totalTokens}
      />
    </div>
  );
}
