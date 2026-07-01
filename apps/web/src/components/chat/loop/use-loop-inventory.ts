import {
  decodeTrevorEvent,
  type LoopInventoryRow,
  loopSnapshotToInventoryRow,
  type SessionEvent,
} from "@trevor/session";
import { useMemo } from "react";

export function loopInventoryRowsFromEvents(
  events: readonly SessionEvent[],
): readonly LoopInventoryRow[] {
  const byId = new Map<string, LoopInventoryRow>();
  for (const event of events) {
    if (event.type !== "loop.status") {
      continue;
    }
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type !== "loop.status") {
      continue;
    }
    const row = loopSnapshotToInventoryRow(decoded.snapshot);
    if (row === null) {
      byId.delete(decoded.snapshot.loopId);
    } else {
      byId.set(row.loopId, row);
    }
  }
  return [...byId.values()].sort((a, b) => a.loopId.localeCompare(b.loopId));
}

export function useLoopInventory(events: readonly SessionEvent[]): readonly LoopInventoryRow[] {
  return useMemo(() => loopInventoryRowsFromEvents(events), [events]);
}
