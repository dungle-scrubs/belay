import type { SessionSummary } from "@trevor/session";

/**
 * Fork LINEAGE derivation (plan 15, M3), pure over the session inventory. A session's `forkedFrom`
 * (surfaced by the inventory projection) links a child to the parent it branched from and the parent seq
 * it branched at; this walks those links into the view a lineage navigator renders: the ancestor chain up
 * to the root, the current session, and its direct children. No transcript access - just the inventory.
 */

/** One node in a lineage view. `forkSeq` is the parent seq this node branched at (absent for a root). */
export interface LineageNode {
  readonly sessionId: string;
  readonly title: string;
  readonly forkSeq?: number;
  /** True when the node is a stub for a parent no longer in the inventory (deleted/purged) - shown so the
   *  lineage link is still visible, but not navigable to real data. */
  readonly missing?: boolean;
}

export interface Lineage {
  /** Ancestors from the ROOT down to the immediate parent (root first); empty for a root session. */
  readonly ancestors: readonly LineageNode[];
  readonly current: LineageNode;
  /** Direct children forked FROM the current session, in inventory order. */
  readonly children: readonly LineageNode[];
}

function toNode(summary: SessionSummary): LineageNode {
  return {
    sessionId: summary.sessionId,
    title: summary.title,
    ...(summary.forkedFrom ? { forkSeq: summary.forkedFrom.forkSeq } : {}),
  };
}

/**
 * Builds the lineage view for `currentId` from the inventory, or null when `currentId` is not present.
 * Walks `forkedFrom` up to the root, guarding against a missing parent (recorded as a `missing` stub so
 * the link still shows) and against a cycle (a self/loop link stops the walk), and collects direct
 * children. A root session yields empty ancestors + whatever children branched off it.
 */
export function buildLineage(
  sessions: readonly SessionSummary[],
  currentId: string,
): Lineage | null {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const cur = byId.get(currentId);
  if (!cur) {
    return null;
  }

  const ancestors: LineageNode[] = [];
  const seen = new Set<string>([currentId]);
  let parentId = cur.forkedFrom?.parentSessionId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) {
      // The parent left the inventory (deleted/purged): keep the link as a non-navigable stub.
      ancestors.unshift({ sessionId: parentId, title: parentId, missing: true });
      break;
    }
    ancestors.unshift(toNode(parent));
    parentId = parent.forkedFrom?.parentSessionId;
  }

  const children = sessions.filter((s) => s.forkedFrom?.parentSessionId === currentId).map(toNode);

  return { ancestors, current: toNode(cur), children };
}
