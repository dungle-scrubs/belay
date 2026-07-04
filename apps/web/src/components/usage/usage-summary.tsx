import {
  formatUsageReport,
  type IncidentRow,
  type ModelUsage,
  type ProviderUsage,
  type SessionUsage,
} from "@trevor/session";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { fmtCtx, fmtTokens, formatElapsed } from "@/derive";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/**
 * The usage-summary surface (plan 43 M3). A conservative, source-attributed read of one session's
 * usage: totals, a per-provider and per-model breakdown, and typed failure/retry rows, with a
 * copy/export affordance. It is presentational over the {@link SessionUsage} read model - all
 * partitioning (including the per-model-segment split at a mid-turn `model.switched`) lives in
 * `@trevor/session`, so this component never touches the raw event log.
 *
 * Labels stay deliberately honest: `output` tokens and generation time SUM, but context is shown as a
 * peak (`fmtCtx`) because input overlaps across steps and must never read as a sum; a `~` marks any
 * figure that folds in an unmeasured (untrusted) turn. Nothing here is a cost estimate - the provider's
 * reported tokens are the only currency shown.
 */

/** A neutral display label for a typed provider incident reason (redacted enum -> readable text). */
function incidentLabel(reason: string): string {
  return reason.replace(/_/g, " ");
}

function StatCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "muted" | "warn" | "danger";
}) {
  const valueTone =
    tone === "danger" ? "text-smui-red" : tone === "warn" ? "text-smui-orange" : "text-foreground";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-label tracking-wider uppercase text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-sm tabular-nums", valueTone)}>{value}</span>
    </div>
  );
}

/** A right-aligned numeric cell shared by the provider and model tables. */
function NumCell({ children }: { children: React.ReactNode }) {
  return (
    <td className="py-0.5 pl-3 text-right font-mono text-sm tabular-nums text-muted-foreground">
      {children}
    </td>
  );
}

function ProviderTable({ rows }: { rows: readonly ProviderUsage[] }) {
  return (
    <table className="w-full">
      <thead>
        <tr className="text-label tracking-wider uppercase text-muted-foreground">
          <th className="py-0.5 text-left font-normal">provider</th>
          <th className="py-0.5 pl-3 text-right font-normal">turns</th>
          <th className="py-0.5 pl-3 text-right font-normal">output</th>
          <th className="py-0.5 pl-3 text-right font-normal">time</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.provider}>
            <td className="py-0.5 pr-3 font-mono text-sm text-foreground">{row.provider}</td>
            <NumCell>{row.turns}</NumCell>
            <NumCell>
              {row.trusted ? "" : "~"}
              {fmtTokens(row.outputTokens)}
            </NumCell>
            <NumCell>{formatElapsed(row.genMs, { hours: true })}</NumCell>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ModelTable({ rows }: { rows: readonly ModelUsage[] }) {
  return (
    <table className="w-full">
      <thead>
        <tr className="text-label tracking-wider uppercase text-muted-foreground">
          <th className="py-0.5 text-left font-normal">model</th>
          <th className="py-0.5 pl-3 text-right font-normal">segments</th>
          <th className="py-0.5 pl-3 text-right font-normal">output</th>
          <th className="py-0.5 pl-3 text-right font-normal">peak ctx</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.model}>
            <td className="py-0.5 pr-3 font-mono text-sm text-foreground">{row.model}</td>
            <NumCell>{row.segments}</NumCell>
            <NumCell>
              {row.trusted ? "" : "~"}
              {fmtTokens(row.outputTokens)}
            </NumCell>
            <NumCell>{fmtCtx(row.peakInputTokens)}</NumCell>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IncidentList({
  incidents,
  retries,
}: {
  incidents: readonly IncidentRow[];
  retries: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-label tracking-wider uppercase text-muted-foreground">
        failures &amp; retries
      </span>
      <div className="flex flex-col gap-0.5 font-mono text-sm">
        {incidents.map((incident) => (
          <div key={incident.reason} className="flex items-baseline justify-between gap-3">
            <span className="text-smui-red">{incidentLabel(incident.reason)}</span>
            <span className="tabular-nums text-muted-foreground">{incident.count}</span>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-muted-foreground">provider retries</span>
          <span className="tabular-nums text-muted-foreground">{retries}</span>
        </div>
      </div>
    </div>
  );
}

export interface UsageSummaryProps {
  /** The aggregated session usage read model (from `sessionUsage`/`aggregateUsage`). */
  readonly usage: SessionUsage;
  /** Panel title; defaults to "Usage". */
  readonly title?: string;
}

export function UsageSummary({ usage, title = "Usage" }: UsageSummaryProps) {
  const [copied, setCopied] = useState(false);
  const { totals } = usage;

  const copy = () => {
    void copyText(formatUsageReport(usage)).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    });
  };

  if (totals.turns === 0) {
    return (
      <div className="flex flex-col gap-1 py-1" data-testid="usage-summary">
        <div className="text-label tracking-wider uppercase text-muted-foreground">{title}</div>
        <p className="text-sm text-muted-foreground">No usage recorded yet.</p>
      </div>
    );
  }

  const approx = totals.trusted ? "" : "~";

  return (
    <div className="flex flex-col gap-3 py-1" data-testid="usage-summary">
      <div className="flex items-center gap-2">
        <span className="text-label tracking-wider uppercase text-muted-foreground">{title}</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ml-auto text-muted-foreground"
          onClick={copy}
          aria-label="Copy usage summary"
        >
          {copied ? "copied" : "copy"}
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-x-4 gap-y-2">
        <StatCell label="turns" value={String(totals.turns)} />
        <StatCell label="output tok" value={`${approx}${fmtTokens(totals.outputTokens)}`} />
        <StatCell label="peak ctx" value={fmtCtx(totals.peakInputTokens)} />
        <StatCell label="gen time" value={formatElapsed(totals.genMs, { hours: true })} />
        <StatCell
          label="failed"
          value={String(totals.failed)}
          tone={totals.failed > 0 ? "danger" : "muted"}
        />
        <StatCell
          label="switches"
          value={String(totals.switches)}
          tone={totals.switches > 0 ? "warn" : "muted"}
        />
      </div>

      {usage.byProvider.length > 0 ? <ProviderTable rows={usage.byProvider} /> : null}
      {usage.byModel.length > 0 ? <ModelTable rows={usage.byModel} /> : null}
      {usage.incidents.length > 0 || totals.retries > 0 ? (
        <IncidentList incidents={usage.incidents} retries={totals.retries} />
      ) : null}

      <p className="text-label text-muted-foreground/70">
        Provider-reported tokens; input is a peak, not a sum.{" "}
        {approx ? "~ marks an estimate that " : ""}
        {approx ? "includes an unmeasured turn." : ""}
      </p>
    </div>
  );
}
