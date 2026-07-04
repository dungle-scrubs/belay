import { access, appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomicVia } from "@host/io/atomic-write";
import { resolveTrevorHome, storagePathByName } from "@trevor/session/node-paths";
import type { ProviderFailureClass } from "./failure-taxonomy";
import {
  decodeObservationEnvelope,
  decodeObservationValue,
  foldObservationDelta,
  OBSERVATION_KIND_FILES,
  OBSERVATION_KINDS,
  type ObservationEnvelope,
  type ObservationKind,
  providerFailureEnvelope,
} from "./observation-envelope";

/**
 * The filesystem persistence layer for the local observation corpus (plan 29 M1/M3/M5). Each producer
 * kind appends redacted shape deltas to its own append-only JSONL log under
 * `<TREVOR_STATE_HOME>/observations/`; a single `index.json` holds the deduped aggregate folded over
 * those logs. The JSONL is the source of truth, so a corrupt or stale index is always repairable by
 * replaying the logs. Writes are best-effort - a disk problem never throws into a user's turn - and
 * export/delete give the corpus user-visible control paths.
 *
 * Responsible for: path resolution, append + index fold, index repair, migration, export, and delete.
 * Not for: the envelope shape or fingerprinting (observation-envelope.ts / failure-record-schema.ts)
 * or the producer callsites (observation-store.ts).
 */

/** The corpus directory `<TREVOR_STATE_HOME>/observations`, resolved through the storage inventory. */
export function corpusDir(): string {
  return storagePathByName("observation-corpus");
}

/** One producer kind's append-only JSONL log under the corpus dir. */
export function corpusJsonlPath(kind: ObservationKind): string {
  return join(corpusDir(), OBSERVATION_KIND_FILES[kind]);
}

/** The deduped aggregate index spanning every producer kind. */
export function corpusIndexPath(): string {
  return storagePathByName("observation-index");
}

/** Async existence check for the one-time migration gate (reads/writes elsewhere operate-and-catch). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** A deduped index keyed by fingerprint. */
export type ObservationIndex = Record<string, ObservationEnvelope>;

/** Folds every valid JSONL sighting across all kinds into a deduped in-memory index. */
async function foldJsonlLogs(): Promise<ObservationIndex> {
  const index: ObservationIndex = {};
  for (const kind of OBSERVATION_KINDS) {
    let raw: string;
    try {
      raw = await readFile(corpusJsonlPath(kind), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const env = decodeObservationEnvelope(line);
      if (env) {
        index[env.fingerprint] = foldObservationDelta(index[env.fingerprint], env);
      }
    }
  }
  return index;
}

/**
 * Reads the deduped index. Prefers the persisted `index.json` (the fast path), but any missing,
 * unparseable, or corrupt-record index falls back to an in-memory rebuild from the JSONL logs so a
 * damaged index can never lose the underlying evidence. The rebuild here is not persisted; call
 * {@link rebuildCorpusIndex} to heal `index.json` on disk.
 */
export async function readCorpusIndex(): Promise<ObservationIndex> {
  try {
    const parsed = JSON.parse(await readFile(corpusIndexPath(), "utf8")) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const index: ObservationIndex = {};
      let clean = true;
      for (const [fingerprint, value] of Object.entries(parsed)) {
        const env = decodeObservationValue(value);
        if (!env) {
          clean = false;
          break;
        }
        index[fingerprint] = env;
      }
      if (clean) {
        return index;
      }
    }
  } catch {
    // Missing or unparseable index: fall through to a JSONL rebuild.
  }
  return foldJsonlLogs();
}

/** Rebuilds `index.json` from the JSONL logs and persists it (the explicit repair path). */
export async function rebuildCorpusIndex(): Promise<ObservationIndex> {
  const index = await foldJsonlLogs();
  await writeIndex(index);
  return index;
}

/** Temp-write + rename, so a concurrent reader (or a mid-write crash) never observes a torn file. */
function atomicWrite(path: string, content: string): Promise<void> {
  return writeFileAtomicVia(
    { writeFile: (p, d) => writeFile(p, d, "utf8"), rename },
    path,
    content,
  );
}

async function writeIndex(index: ObservationIndex): Promise<void> {
  await mkdir(corpusDir(), { recursive: true });
  await atomicWrite(corpusIndexPath(), `${JSON.stringify(index, null, 2)}\n`);
}

/**
 * Appends one sighting delta to its kind's JSONL log and folds it into the index. Best-effort: any
 * read/write/serialize failure is swallowed and returns null so a diagnostic write never fails the
 * user's turn. Returns the resulting deduped aggregate for callers that want to assert.
 */
export async function appendObservation(
  delta: ObservationEnvelope,
): Promise<ObservationEnvelope | null> {
  try {
    // Read the prior index BEFORE appending so the new line is folded exactly once (no double count).
    const index = await readCorpusIndex();
    await mkdir(corpusDir(), { recursive: true });
    await appendFile(corpusJsonlPath(delta.kind), `${JSON.stringify(delta)}\n`, "utf8");
    const folded = foldObservationDelta(index[delta.fingerprint], delta);
    index[delta.fingerprint] = folded;
    await writeIndex(index);
    return folded;
  } catch {
    return null;
  }
}

/** Exports the deduped, already-redacted records (M5). Safe to hand to a user or an export bundle. */
export async function exportCorpus(): Promise<ObservationEnvelope[]> {
  return Object.values(await readCorpusIndex());
}

/** Deletes the entire corpus directory (M5). Best-effort; a missing dir is a no-op. */
export async function deleteCorpus(): Promise<void> {
  await rm(corpusDir(), { recursive: true, force: true });
}

/** Deletes one kind's JSONL log, then rebuilds the index so its entries drop out (M5). */
export async function deleteByKind(kind: ObservationKind): Promise<void> {
  await rm(corpusJsonlPath(kind), { force: true });
  await rebuildCorpusIndex();
}

/**
 * Deletes one fingerprint (M5). Because the JSONL is append-only, deletion rewrites each kind's log
 * without the matching lines and then rebuilds the index. Returns whether anything was removed.
 */
export async function deleteByFingerprint(fingerprint: string): Promise<boolean> {
  let removed = false;
  for (const kind of OBSERVATION_KINDS) {
    const path = corpusJsonlPath(kind);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const kept: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const env = decodeObservationEnvelope(line);
      if (env && env.fingerprint === fingerprint) {
        removed = true;
      } else {
        kept.push(line);
      }
    }
    await atomicWrite(path, kept.length ? `${kept.join("\n")}\n` : "");
  }
  if (removed) {
    await rebuildCorpusIndex();
  }
  return removed;
}

/** The flat legacy record shape written by the pre-corpus single-file store (plan 29 migration). */
interface LegacyObservation {
  readonly fingerprint?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly authMode?: unknown;
  readonly phase?: unknown;
  readonly classification?: unknown;
  readonly retryable?: unknown;
  readonly status?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly shapeFields?: unknown;
  readonly outputStarted?: unknown;
  readonly firstSeen?: unknown;
  readonly lastSeen?: unknown;
  readonly count?: unknown;
}

/** Converts one flat legacy record into a delta envelope, preserving its count/first/last span. */
function legacyToDelta(record: LegacyObservation): ObservationEnvelope | null {
  if (
    typeof record.provider !== "string" ||
    typeof record.phase !== "string" ||
    typeof record.classification !== "string" ||
    typeof record.message !== "string"
  ) {
    return null;
  }
  const nowFallback = new Date(0).toISOString();
  const first = typeof record.firstSeen === "string" ? record.firstSeen : nowFallback;
  const last = typeof record.lastSeen === "string" ? record.lastSeen : first;
  const delta = providerFailureEnvelope(
    {
      provider: record.provider,
      model: typeof record.model === "string" ? record.model : undefined,
      authMode: typeof record.authMode === "string" ? record.authMode : undefined,
      phase: record.phase,
      // The legacy classification is already one of the provider classes; trust it defensively.
      classification: record.classification as ProviderFailureClass,
      retryable: record.retryable === true,
      status: typeof record.status === "number" ? record.status : undefined,
      code: typeof record.code === "string" ? record.code : undefined,
      message: record.message,
      shapeFields: Array.isArray(record.shapeFields)
        ? record.shapeFields.filter((f): f is string => typeof f === "string")
        : undefined,
      outputStarted: record.outputStarted === true,
    },
    first,
  );
  return {
    ...delta,
    lastSeen: last,
    count: typeof record.count === "number" && record.count > 0 ? record.count : 1,
  };
}

function legacySources(): readonly string[] {
  return [
    // The pre-corpus state-home single file, and the even-older config-home location.
    storagePathByName("provider-observations"),
    join(resolveTrevorHome(), "provider-observations.json"),
  ];
}

/**
 * One-time, best-effort migration of the pre-corpus single-file provider observations into the corpus
 * (plan 29 M1). Runs only when the corpus has no provider-failures log yet, imports each legacy record
 * (preserving fingerprint/count/span), and renames each consumed legacy file to a `.migrated.json`
 * tombstone so the same records are never re-imported after a corpus delete. Non-destructive: the old
 * data is preserved under the tombstone, not deleted.
 */
export async function ensureMigrated(): Promise<void> {
  try {
    if (await pathExists(corpusJsonlPath("provider_failure"))) {
      return;
    }
    for (const source of legacySources()) {
      let parsed: Record<string, LegacyObservation>;
      try {
        parsed = JSON.parse(await readFile(source, "utf8")) as Record<string, LegacyObservation>;
      } catch {
        // A missing or unparseable legacy file: nothing to migrate from this source.
        continue;
      }
      if (parsed && typeof parsed === "object") {
        for (const record of Object.values(parsed)) {
          const delta = legacyToDelta(record);
          if (delta) {
            await appendObservation(delta);
          }
        }
      }
      await rename(source, `${source.replace(/\.json$/, "")}.migrated.json`).catch(() => {});
    }
  } catch {
    // Migration is best-effort: a failure leaves the legacy file in place and never affects a turn.
  }
}
