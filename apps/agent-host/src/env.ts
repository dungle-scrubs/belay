/**
 * The one owner of "read a numeric/flag env override with a default." The host had this idiom spelled
 * five divergent ways - `Number.isFinite(Number(raw)) ? Number(raw) : d`, `Number(x) || d` (which also
 * swallows a legitimate 0), and `value ? Number(value) : undefined` (which had no finite check at all) -
 * so the empty/NaN/zero edge behavior drifted per callsite. These give every numeric override one
 * policy: unset, blank, or non-finite falls back; a finite value (including 0) is honored. Per-provider
 * model-name and URL env reads stay decentralized by existing design; this is only for the numbers.
 */

/** The parsed finite number for env var `name`, or `fallback` when it is unset, blank, or non-finite. */
export function envNumber(name: string, fallback: number): number;
export function envNumber(name: string, fallback?: number): number | undefined;
export function envNumber(name: string, fallback?: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** True when env var `name` is set to the enabling literal `"1"` (the host's flag convention). */
export function envFlag(name: string): boolean {
  return process.env[name] === "1";
}
