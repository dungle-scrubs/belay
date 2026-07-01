import { mkdirSync, openSync, statSync, writeSync } from "node:fs";

/**
 * The shared append-only, byte-capped JSONL writer behind the local telemetry file exporters (plan 13):
 * both {@link ./telemetry-file-sink} (spans + metrics) and {@link ./telemetry-provider-trace} (provider
 * attempts) delegate here so the open/cap/drop-count/guard logic lives in ONE place.
 *
 * It is best-effort and bounded: past the byte cap, records are DROPPED and counted (not rotated); a
 * write failure (full disk, permissions) is swallowed and counted so telemetry never fails user work. It
 * opens ONE append fd lazily on the first record and reuses it (`writeSync`), so a hot service does not
 * pay an open+write+close per event; the fd lives for the process. Each record is stamped with `at`.
 */

export interface CappedJsonlStats {
  readonly written: number;
  readonly dropped: number;
}

export interface CappedJsonlWriter {
  /** Appends one record as a JSON line (best-effort; stamps `at`). */
  append(record: object): void;
  stats(): CappedJsonlStats;
}

export interface CappedJsonlOptions {
  /** The target file. */
  readonly path: string;
  /** The directory to create on first write. */
  readonly dir: string;
  /** Byte cap; writes past it are dropped + counted. */
  readonly maxBytes: number;
  /** Clock for the record `at` timestamp. */
  readonly now: () => number;
}

export function createCappedJsonlWriter(opts: CappedJsonlOptions): CappedJsonlWriter {
  let written = 0;
  let dropped = 0;
  let fd: number | null = null;
  let opened = false;
  // Seed the size from the existing file (a prior run's artifacts count toward the cap) so the cap check
  // is a comparison, not a stat per write.
  let bytes = currentSize(opts.path);

  const ensureFd = (): boolean => {
    if (!opened) {
      opened = true;
      try {
        mkdirSync(opts.dir, { recursive: true });
        fd = openSync(opts.path, "a");
      } catch {
        fd = null;
      }
    }
    return fd !== null;
  };

  return {
    append(record: object): void {
      // Short-circuit once full: skip even the stringify for every subsequent (dropped) record.
      if (bytes >= opts.maxBytes) {
        dropped += 1;
        return;
      }
      let line = "";
      try {
        line = `${JSON.stringify({ ...record, at: new Date(opts.now()).toISOString() })}\n`;
      } catch {
        dropped += 1;
        return;
      }
      if (bytes + line.length > opts.maxBytes || !ensureFd() || fd === null) {
        dropped += 1;
        return;
      }
      try {
        writeSync(fd, line);
        bytes += line.length;
        written += 1;
      } catch {
        dropped += 1;
      }
    },
    stats: () => ({ written, dropped }),
  };
}

/** The current size of `path` in bytes, or 0 when it does not exist yet. */
function currentSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
