import type { UsageBreakdown } from "@trevor/session";
import { X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtCtx } from "@/derive";
import { useArmedAfterMount } from "@/hooks/use-armed-after-mount";
import { panelBreakdown } from "./breakdown";
import { Treemap } from "./Treemap";

const fmtTok = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
const pct = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;

export interface SidePanelProps {
  /** Session name, shown as the panel title. */
  readonly title: string;
  /** Secondary line under the title (status, time, …). */
  readonly subtitle?: string;
  /** Host / connection status line, rendered under the header. */
  readonly statusNode?: ReactNode;
  readonly workspace?: string;
  readonly branch?: string;
  /** Tokens consumed by the latest call (its input), for the context meter. */
  readonly ctxUsed?: number;
  /** Context-window size for the latest call (the maximum), for the context meter. */
  readonly ctxMax?: number;
  /** Total tokens for the latest call (input + output), for the Request tab. */
  readonly totalTokens?: number;
  readonly breakdown?: UsageBreakdown;
  /** Aggregated breakdown across all requests in the current context window. */
  readonly contextBreakdown?: UsageBreakdown;
  /** Total tokens across all requests in the current context window. */
  readonly contextTokens?: number;
  /** Model / reasoning controls, injected by the host so the panel stays presentational. */
  readonly controls?: ReactNode;
  readonly onClose?: () => void;
}

/**
 * The toggleable right-side panel: session header, a workspace/context bar, the
 * "data in this call" token treemap, and (at the bottom) the model controls.
 * Presentational - the live app feeds it derived state and the controls slot.
 */
export function SidePanel({
  title,
  subtitle,
  statusNode,
  workspace,
  branch,
  ctxUsed,
  ctxMax,
  totalTokens,
  breakdown,
  contextBreakdown,
  contextTokens,
  controls,
  onClose,
}: SidePanelProps) {
  const [tab, setTab] = useState<"request" | "context">("request");
  const activeTotal = tab === "request" ? totalTokens : contextTokens;

  // The ctx meter snaps to its value on first appearance; only later updates glide.
  const showMeter = ctxUsed != null && ctxMax != null && ctxMax > 0;
  const meterArmed = useArmedAfterMount(showMeter);

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col gap-4 border-l border-border bg-card/40 px-4 py-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-foreground">{title}</h2>
          {subtitle ? (
            <p className="truncate text-label tracking-wider text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="-mr-1 shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      {statusNode ? <div className="text-label tracking-wider">{statusNode}</div> : null}

      {workspace ? (
        <div className="flex items-center gap-2 border border-border bg-background px-3 py-2 text-xs">
          <code className="truncate text-foreground">{workspace}</code>
          {branch ? <span className="shrink-0 text-muted-foreground">· {branch}</span> : null}
        </div>
      ) : null}

      {showMeter ? (
        <div className="flex items-center gap-2 border border-border bg-background px-3 py-2 text-xs">
          <span className="shrink-0 text-muted-foreground">ctx</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
            <div
              className={`h-full rounded-full bg-primary${
                meterArmed ? " transition-[width] duration-300 ease-out" : ""
              }`}
              style={{ width: `${Math.min(100, pct(ctxUsed, ctxMax))}%` }}
            />
          </div>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            <span className="text-foreground">{pct(ctxUsed, ctxMax)}%</span> of {fmtCtx(ctxMax)}
          </span>
        </div>
      ) : null}

      <section>
        <Tabs value={tab} onValueChange={(v) => setTab(v as "request" | "context")}>
          <div className="flex items-center justify-between gap-2">
            <TabsList>
              <TabsTrigger value="request" title="This request">
                Request
              </TabsTrigger>
              <TabsTrigger value="context" title="All requests in the current context">
                Context
              </TabsTrigger>
            </TabsList>
            {activeTotal != null ? (
              <span className="text-label tracking-wider text-muted-foreground">
                {fmtTok(activeTotal)} tok
              </span>
            ) : null}
          </div>

          <TabsContent value="request">
            <BreakdownView
              breakdown={breakdown}
              totalTokens={totalTokens}
              emptyLabel="No call data yet"
            />
          </TabsContent>
          <TabsContent value="context">
            <BreakdownView
              breakdown={contextBreakdown}
              totalTokens={contextTokens}
              emptyLabel="No context yet"
            />
          </TabsContent>
        </Tabs>
      </section>

      {controls ? (
        <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">{controls}</div>
      ) : null}
    </aside>
  );
}

/**
 * Treemap + legend for a single breakdown - one request, or the whole context.
 * Token counts are apportioned from `totalTokens` by each segment's share; falls
 * back to a dashed empty state when there's nothing to show.
 */
function BreakdownView({
  breakdown,
  totalTokens,
  emptyLabel,
}: {
  breakdown?: UsageBreakdown;
  totalTokens?: number;
  emptyLabel: string;
}) {
  const bd = breakdown ? panelBreakdown(breakdown) : null;

  if (!bd || bd.total <= 0) {
    return (
      <div className="border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Treemap leaves={bd.leaves} total={bd.total} totalTokens={totalTokens} height={184} />
      {/* One legend row per treemap cell (biggest first), so the list and the
          treemap always agree on what's shown. */}
      <ul className="flex flex-col gap-1">
        {[...bd.leaves]
          .sort((a, c) => c.value - a.value)
          .map((leaf) => {
            const leafTokens =
              totalTokens != null && bd.total > 0
                ? Math.round((leaf.value / bd.total) * totalTokens)
                : null;
            const share = pct(leaf.value, bd.total);
            const shareLabel = share === 0 && leaf.value > 0 ? "<1%" : `${share}%`;
            return (
              <li key={leaf.key} className="flex items-center gap-2 text-sm">
                <span
                  className="size-2.5 shrink-0 rounded-[2px]"
                  style={{ background: leaf.color }}
                />
                <span className="truncate text-foreground">{leaf.label}</span>
                <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                  {leafTokens != null ? `${fmtTok(leafTokens)} · ${shareLabel}` : shareLabel}
                </span>
              </li>
            );
          })}
      </ul>
    </div>
  );
}
