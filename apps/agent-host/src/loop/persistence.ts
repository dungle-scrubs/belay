import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TREVOR_STATE_HOME } from "@host/boot/paths";
import type { LoopState } from "./domain";

/**
 * Durable `/loop` PERSISTENCE (plan 17, M6): the last-known state of every DURABLE loop, kept in one JSON
 * map under the approved runtime state root ({@link TREVOR_STATE_HOME}, the same home sessions/blobs use).
 * A durable loop survives a host restart with its status, counters, and next-run time intact; a `session`
 * loop is never written here. This is the ONLY loop file IO - the store stays transient and calls `save`
 * on each durable change, then rehydrates from `load` at startup, keeping the two clearly separated (D-072).
 *
 * Responsible for: durable loop storage - the loops.json save/load under the state root.
 * Not for: deciding when to persist - store.ts calls save on each durable change.
 */

/** A persisted durable loop: its domain state plus the epoch-ms next-run time it was scheduled for. */
export type PersistedLoop = LoopState & { readonly nextRun?: number };

export interface LoopPersistence {
  /** Upsert one durable loop's latest record (keyed by id). A `deleted` record PRUNES the loop from the
   *  file rather than persisting a tombstone, so the file cannot grow without bound. */
  save(record: PersistedLoop): void;
  /** Every persisted durable loop, for rehydration at startup. */
  load(): PersistedLoop[];
}

/**
 * Opens durable loop storage at `filePath` (default: `loops.json` under the state root). Reads tolerate a
 * missing or corrupt file (treated as empty), so a bad file never crashes startup - the loops just don't
 * restore.
 */
export function createLoopPersistence(
  filePath: string = join(TREVOR_STATE_HOME, "loops.json"),
): LoopPersistence {
  const readAll = (): Record<string, PersistedLoop> => {
    if (!existsSync(filePath)) {
      return {};
    }
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      return parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, PersistedLoop>)
        : {};
    } catch {
      return {};
    }
  };
  return {
    save(record) {
      const all = readAll();
      if (record.status === "deleted") {
        delete all[record.id]; // prune rather than persist a growing tombstone
      } else {
        all[record.id] = record;
      }
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(all, null, 2));
    },
    load() {
      return Object.values(readAll());
    },
  };
}
