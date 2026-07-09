import {
  type CatalogEntry,
  decodeTrevorEvent,
  type ReadLogOptions,
  type SessionEvent,
  type SourceSummary,
} from "@trevor/session";
import type { TrevorClient } from "./client";

/**
 * Projects the host-announced model catalog from the durable session log.
 *
 * Responsible for: the SDK read model for `host.online` model sources and the per-source catalog.
 * Not for: provider discovery or model probing, which stay host-owned.
 */

export interface CatalogSnapshot {
  readonly sources: readonly SourceSummary[];
  readonly catalogBySource: Readonly<Record<string, readonly CatalogEntry[]>>;
}

export const EMPTY_CATALOG_SNAPSHOT: CatalogSnapshot = {
  sources: [],
  catalogBySource: {},
};

export function projectCatalog(events: readonly SessionEvent[]): CatalogSnapshot {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) {
      continue;
    }
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type === "host.online") {
      return {
        sources: decoded.sources,
        catalogBySource: decoded.catalog,
      };
    }
  }
  return EMPTY_CATALOG_SNAPSHOT;
}

export async function listCatalog(
  client: TrevorClient,
  sessionId: string,
  options?: ReadLogOptions,
): Promise<CatalogSnapshot> {
  return projectCatalog(await client.readLog(sessionId, options));
}
