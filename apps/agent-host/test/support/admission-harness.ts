import {
  ADMISSION_STALE_MS,
  type AdmissionCaps,
  type AdmissionFs,
} from "../../src/admission/store";

/**
 * The shared in-memory admission test harness (plan 11): one backing fs + fake clock + pid-liveness set
 * that every admission unit test drives, so capacity/queue/heartbeat/stale/cancellation behavior is
 * exercised without real files or processes. Two `caps` (`a`/`b`) over the SAME backing fs model two
 * independent host processes contending for one resource; single-process tests use `caps` (an alias for
 * `a`). The fake fs is the in-memory mirror of `nodeAdmissionFs` (including the `renameIfExists` mutex
 * primitive); `listResources` lists real `.json` files so the /doctor snapshot path is testable too.
 */

export const ADMISSION_TEST_DIR = "/state/admission";

export interface AdmissionHarness {
  /** Process A's capabilities (also exposed as `caps` for single-process tests). */
  readonly a: AdmissionCaps;
  /** Process B's capabilities over the SAME backing fs/clock (cross-process contention). */
  readonly b: AdmissionCaps;
  /** Alias for {@link a}, for single-process tests. */
  readonly caps: AdmissionCaps;
  /** Mark a pid alive (so its records aren't reaped). */
  readonly spawn: (pid: number) => void;
  /** Mark a pid dead (a crash; its held/queued records become reapable). */
  readonly kill: (pid: number) => void;
  /** Advance the shared clock by `ms`. */
  readonly advance: (ms: number) => void;
  /** Set the shared clock to an absolute epoch-ms. */
  readonly setClock: (ms: number) => void;
}

export function makeAdmissionHarness(opts: { staleAfterMs?: number } = {}): AdmissionHarness {
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const alive = new Set<number>();
  let clock = 1_700_000_000_000;
  const fs: AdmissionFs = {
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => {
      files.set(p, c);
      mtimes.set(p, clock);
    },
    remove: (p) => {
      files.delete(p);
      mtimes.delete(p);
    },
    createExclusive: (p) => {
      if (files.has(p)) {
        return false;
      }
      files.set(p, "");
      mtimes.set(p, clock);
      return true;
    },
    renameIfExists: (from, to) => {
      const content = files.get(from);
      if (content === undefined) {
        return false;
      }
      files.set(to, content);
      mtimes.set(to, clock);
      files.delete(from);
      mtimes.delete(from);
      return true;
    },
    mtimeMs: (p) => mtimes.get(p) ?? null,
    listResources: (dir) =>
      [...files.keys()]
        .filter((k) => k.startsWith(`${dir}/`) && k.endsWith(".json"))
        .map((k) => k.slice(dir.length + 1)),
  };
  const caps = (): AdmissionCaps => ({
    fs,
    now: () => clock,
    processAlive: (pid) => alive.has(pid),
    sleep: async (ms) => {
      clock += ms;
    },
    dir: ADMISSION_TEST_DIR,
    staleAfterMs: opts.staleAfterMs ?? ADMISSION_STALE_MS,
  });
  const a = caps();
  return {
    a,
    b: caps(),
    caps: a,
    spawn: (pid) => alive.add(pid),
    kill: (pid) => alive.delete(pid),
    advance: (ms) => {
      clock += ms;
    },
    setClock: (ms) => {
      clock = ms;
    },
  };
}
