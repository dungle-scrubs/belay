import type { GitStatus, UsageBreakdown } from "@trevor/session";
import { type ReactNode, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtCtx, fmtTokens } from "@/derive";
import { useArmedAfterMount } from "@/hooks/use-armed-after-mount";
import { panelBreakdown } from "./breakdown";
import { DrawerToggle, SideDrawer } from "./side-drawer";
import { Treemap } from "./Treemap";
import { WorkspaceIdentity } from "./WorkspaceIdentity";

const pct = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;

export interface SidePanelHeaderProps {
  /** Session name, shown as the panel title. */
  readonly title: string;
  /** Secondary line under the title (status, time, …). */
  readonly subtitle?: string;
  /** Host / connection status line, rendered under the header. */
  readonly statusNode?: ReactNode;
  /** Effective cwd, shown as the first line of the workspace identity block. */
  readonly workspace?: string;
  /** Structured git status for the workspace, rendered as the branch/status line under cwd. */
  readonly git?: GitStatus | null;
  /** Count of other managed worktrees; drives the `+N worktrees` link under the branch. */
  readonly worktreeCount?: number;
  /** Opens the worktree switcher from the workspace block (same as `/worktree`). */
  readonly onOpenWorktrees?: () => void;
}

export interface SidePanelBreakdownProps {
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
  /**
   * Whether the session has finished its initial replay. Transitions stay off until
   * this is true so a refresh - where data streams in event by event - settles into
   * place without animating; only live changes after load glide. Defaults to true so
   * static usages (e.g. stories) animate normally.
   */
  readonly ready?: boolean;
}

export interface SidePanelProps {
  /** Model / reasoning controls, injected by the host so the panel stays presentational. */
  readonly controls?: ReactNode;
  /** Session affordances (resume / worktree / session id) pinned inline at the panel's bottom. */
  readonly footer?: ReactNode;
  /**
   * Whether the session has finished its initial replay. Transitions stay off until
   * this is true so a refresh - where data streams in event by event - settles into
   * place without animating; only live changes after load glide. Defaults to true so
   * static usages (e.g. stories) animate normally.
   */
  readonly ready?: boolean;
  readonly onClose?: () => void;
  readonly children?: ReactNode;
}

/**
 * The toggleable right-side panel: session header, a workspace/context bar, the
 * "data in this call" token treemap, and (at the bottom) the model controls.
 * Presentational - the live app feeds it derived state and the controls slot.
 */
export function SidePanel({ controls, footer, onClose, children }: SidePanelProps) {
  return (
    <SideDrawer
      side="right"
      ariaLabel="session detail"
      widthClass="w-80"
      toneClass="bg-card/40"
      className="px-4 pb-4"
    >
      {/* Flush top strip, same height as the main top bar, so the collapse toggle lines up vertically
        with the top-bar toggles. The collapse glyph is the SAME PanelRight icon used to open the
        panel, on the inner (left) edge. */}
      {onClose ? (
        <div className="flex h-8 shrink-0 items-center">
          <DrawerToggle side="right" onClick={onClose} label="Collapse panel" />
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {children}

        {controls || footer ? (
          <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
            {controls}
            {footer ? (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">{footer}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </SideDrawer>
  );
}

export function SidePanelHeader({
  title,
  subtitle,
  statusNode,
  workspace,
  git,
  worktreeCount,
  onOpenWorktrees,
}: SidePanelHeaderProps) {
  return (
    <>
      <div className="min-w-0">
        <h2 className="truncate font-semibold text-foreground">{title}</h2>
        {subtitle ? (
          <p className="truncate text-label tracking-wider text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>

      {statusNode ? <div className="text-label tracking-wider">{statusNode}</div> : null}

      {workspace ? (
        <WorkspaceIdentity
          cwd={workspace}
          git={git}
          worktreeCount={worktreeCount}
          onOpenWorktrees={onOpenWorktrees}
        />
      ) : null}
    </>
  );
}

export function SidePanelBreakdown({
  ctxUsed,
  ctxMax,
  totalTokens,
  breakdown,
  contextBreakdown,
  contextTokens,
  ready = true,
}: SidePanelBreakdownProps) {
  const [tab, setTab] = useState<"request" | "context">("request");
  const activeTotal = tab === "request" ? totalTokens : contextTokens;

  // The ctx meter snaps to its value on first appearance and through the initial
  // replay; only live updates once the session is ready glide.
  const showMeter = ctxUsed != null && ctxMax != null && ctxMax > 0;
  const meterArmed = useArmedAfterMount(ready && showMeter);

  return (
    <>
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
              <TabsTrigger value="request" title="This turn">
                turn
              </TabsTrigger>
              <TabsTrigger value="context" title="All turns in the current session">
                session
              </TabsTrigger>
            </TabsList>
            {activeTotal != null ? (
              <span className="text-label tracking-wider text-muted-foreground">
                {fmtTokens(activeTotal)} tok
              </span>
            ) : null}
          </div>

          <TabsContent value="request">
            <BreakdownView
              breakdown={breakdown}
              totalTokens={totalTokens}
              emptyLabel="No turn data yet"
              ready={ready}
            />
          </TabsContent>
          <TabsContent value="context">
            <BreakdownView
              breakdown={contextBreakdown}
              totalTokens={contextTokens}
              emptyLabel="No session data yet"
              ready={ready}
            />
          </TabsContent>
        </Tabs>
      </section>
    </>
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
  ready,
}: {
  breakdown?: UsageBreakdown;
  totalTokens?: number;
  emptyLabel: string;
  ready?: boolean;
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
      <Treemap
        leaves={bd.leaves}
        total={bd.total}
        totalTokens={totalTokens}
        height={184}
        ready={ready}
      />
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
                  {leafTokens != null ? `${fmtTokens(leafTokens)} · ${shareLabel}` : shareLabel}
                </span>
              </li>
            );
          })}
      </ul>
    </div>
  );
}
