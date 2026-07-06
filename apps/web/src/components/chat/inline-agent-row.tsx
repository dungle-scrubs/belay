import { TreeBranch } from "@/components/tree-branch";
import { useElapsedLabel } from "@/hooks/use-elapsed-label";
import { cn } from "@/lib/utils";
import type { InlineAgent, InlineAgentStatus } from "@/transcript";
import { ShimmerText } from "./action-shimmer";
import { formatOutputTokenCell } from "./turn-status-header";

/**
 * Responsible for: the compact one-line inline-agent transcript row (plan 09.4 M1). A blocking
 * `delegate_inline` child renders here as a bare row - `◆ agent · model · <thinking> · (<elapsed> ·
 * ↓ <tokens> tokens)` - status-toned (running/done/failed/interrupted) and visually distinct from a
 * bordered tool card. `InlineAgentGroup` stacks the parallel children of one parent turn under a
 * header with the shared `└` tree branch; a lone child is a bare row with no branch. The `full`
 * variant shows every cell; `compact` drops the thinking-level cell under width / count pressure.
 *
 * Not for: deciding the values (agent/model/reasoning/tokens/status/startedAt come from the
 * transcript projection in `transcript.ts`, M3), subscribing to the child session, or rendering the
 * details view (M6). Presentational: props in, one row out; the caller wires `onOpen` (the click that
 * opens the child's live transcript takeover).
 */

// `InlineAgent` / `InlineAgentStatus` are the read-model shapes owned by `@/transcript` (the
// component-free transcript projection); this row just renders them. `InlineAgentVariant` is
// presentational-only, so it lives here.
export type InlineAgentVariant = "full" | "compact";

// The delegation status vocabulary is its own four-state palette (no existing tool/alert map covers
// `interrupted`, and delegation keeps the purple identity of the block this row replaces), so it gets
// one local literal-class map rather than being forced onto `toolStatusColor` (3 states, no purple).
const INLINE_AGENT_TONE: Record<InlineAgentStatus, string> = {
  running: "text-smui-purple",
  done: "text-smui-green",
  failed: "text-smui-red",
  interrupted: "text-smui-yellow",
};

/** Where the row sits in a group: `first` carries the `└` branch, `rest` aligns beneath it, absent
 *  (a lone row) has no branch cell at all. */
type Branch = "first" | "rest";

export function InlineAgentRow({
  agent,
  variant = "full",
  branch,
  onOpen,
}: {
  readonly agent: InlineAgent;
  readonly variant?: InlineAgentVariant;
  readonly branch?: Branch;
  readonly onOpen?: (childSessionId: string) => void;
}) {
  const running = agent.status === "running";
  // Only tick while running (an undefined delay pauses the shared ticker); terminal rows are static.
  const elapsed = useElapsedLabel(running ? agent.startedAt : undefined);

  // `model · <thinking>` - the compact variant drops the thinking cell first under width pressure.
  const meta = [agent.model, variant === "full" ? agent.reasoningLevel : undefined].filter(
    (cell): cell is string => Boolean(cell),
  );
  // `(elapsed · <terminal note> · ↓ tokens)` - elapsed only while live; a failed/interrupted note
  // names the terminal state the tone already hints; the token cell is hidden until a count exists.
  const paren = [
    running ? elapsed : null,
    agent.status === "failed" || agent.status === "interrupted" ? agent.status : null,
    agent.tokens !== undefined ? formatOutputTokenCell(agent.tokens) : null,
  ].filter((cell): cell is string => Boolean(cell));

  const tone = INLINE_AGENT_TONE[agent.status];
  const content = (
    <>
      {branch ? <TreeBranch first={branch === "first"} /> : null}
      <span className={cn("select-none", tone)} aria-hidden>
        ◆
      </span>
      <span className="min-w-0">
        <span className={cn("font-medium", tone)}>
          {running ? <ShimmerText>{agent.agent}</ShimmerText> : agent.agent}
        </span>
        {meta.length > 0 ? (
          <span className="text-muted-foreground"> · {meta.join(" · ")}</span>
        ) : null}
        {paren.length > 0 ? (
          <span className="text-muted-foreground"> ({paren.join(" · ")})</span>
        ) : null}
      </span>
    </>
  );

  // Clickable when a caller wires `onOpen` (the row opens the child's live transcript, M6); the whole
  // line is the target. `cursor-pointer` comes from the global base layer, never per-component.
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={() => onOpen(agent.childSessionId)}
        className="flex w-full items-baseline gap-1.5 text-left text-sm hover:opacity-80"
      >
        {content}
      </button>
    );
  }
  return <div className="flex items-baseline gap-1.5 text-sm">{content}</div>;
}

/**
 * The parallel-delegation group: one assistant message can spawn several `delegate_inline` children
 * (the host runs tool calls at `toolConcurrency`), so they nest under a small header with the shared
 * `└` branch - the same idiom as the tasks checklist. A lone child skips the header and renders as a
 * bare row, so the common case stays a single quiet line.
 */
export function InlineAgentGroup({
  agents,
  variant,
  onOpen,
}: {
  readonly agents: readonly InlineAgent[];
  /** Forces a variant; by default a large parallel group auto-compacts (drops the thinking cell). */
  readonly variant?: InlineAgentVariant;
  readonly onOpen?: (childSessionId: string) => void;
}) {
  // Many parallel agents drop the thinking cell so a wide group stays scannable (D-001: "abbreviate …
  // when many agents run"); a caller may still force a variant. This is the real width-pressure caller.
  const rowVariant: InlineAgentVariant = variant ?? (agents.length >= 4 ? "compact" : "full");
  // A lone child (or none) skips the header + branch entirely: the common case is one quiet row.
  if (agents.length <= 1) {
    const [only] = agents;
    return only ? <InlineAgentRow agent={only} variant={rowVariant} onOpen={onOpen} /> : null;
  }
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-label uppercase tracking-wider text-muted-foreground">
        {agents.length} agents
      </div>
      {agents.map((agent, index) => (
        <InlineAgentRow
          key={agent.childSessionId}
          agent={agent}
          variant={rowVariant}
          branch={index === 0 ? "first" : "rest"}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
