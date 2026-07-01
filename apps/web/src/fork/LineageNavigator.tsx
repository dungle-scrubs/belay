import type { Lineage, LineageNode } from "./lineage";

/**
 * The fork LINEAGE navigator (plan 15, M3): shows where the current session sits in its fork tree - the
 * ancestor chain up to the root, the current session (highlighted), and any children branched from it -
 * and lets the user jump to another session in the lineage. Presentational + driven by {@link buildLineage}
 * output, so it renders any lineage state (root, deep chain, missing parent) without a live store. It only
 * navigates; it never forks (that is the transcript's branch affordance).
 */

export interface LineageNavigatorProps {
  readonly lineage: Lineage;
  /** Jump to another session in the lineage. Not called for the current node or a missing stub. */
  readonly onNavigate: (sessionId: string) => void;
}

function nodeSubtitle(node: LineageNode): string | null {
  if (node.missing) {
    return "no longer available";
  }
  return node.forkSeq !== undefined ? `branched at #${node.forkSeq}` : null;
}

function LineageRow({
  node,
  kind,
  onNavigate,
}: {
  readonly node: LineageNode;
  readonly kind: "ancestor" | "current" | "child";
  readonly onNavigate: (sessionId: string) => void;
}) {
  const subtitle = nodeSubtitle(node);
  const isCurrent = kind === "current";
  const navigable = !isCurrent && !node.missing;
  const className = [
    "flex flex-col gap-0.5 rounded-md px-2 py-1 text-left text-sm",
    isCurrent ? "bg-card font-medium text-foreground" : "text-muted-foreground",
    node.missing ? "opacity-50" : "",
    navigable ? "hover:bg-card/60 hover:text-foreground" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const content = (
    <>
      <span className="truncate">{node.title}</span>
      {subtitle ? <span className="text-muted-foreground/60 text-xs">{subtitle}</span> : null}
    </>
  );
  if (!navigable) {
    return (
      <div className={className} aria-current={isCurrent ? "true" : undefined}>
        {content}
      </div>
    );
  }
  return (
    <button type="button" className={className} onClick={() => onNavigate(node.sessionId)}>
      {content}
    </button>
  );
}

export function LineageNavigator({ lineage, onNavigate }: LineageNavigatorProps) {
  const { ancestors, current, children } = lineage;
  return (
    <nav aria-label="Session lineage" className="flex flex-col gap-1">
      {ancestors.map((node) => (
        <LineageRow key={node.sessionId} node={node} kind="ancestor" onNavigate={onNavigate} />
      ))}
      <LineageRow node={current} kind="current" onNavigate={onNavigate} />
      {children.length > 0 ? (
        <div className="ml-3 flex flex-col gap-1 border-border border-l pl-2">
          {children.map((node) => (
            <LineageRow key={node.sessionId} node={node} kind="child" onNavigate={onNavigate} />
          ))}
        </div>
      ) : null}
    </nav>
  );
}
