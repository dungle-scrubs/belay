/**
 * The one owner of "read a numeric/flag env override with a default." The host had this idiom spelled
 * five divergent ways - `Number.isFinite(Number(raw)) ? Number(raw) : d`, `Number(x) || d` (which also
 * swallows a legitimate 0), and `value ? Number(value) : undefined` (which had no finite check at all) -
 * so the empty/NaN/zero edge behavior drifted per callsite. These give every numeric override one
 * policy: unset, blank, or non-finite falls back; a finite value (including 0) is honored. Duration
 * knobs that must stay strictly positive (a zero timeout is never a real override) read through
 * `envPositiveMs`, which is also injectable for pure env -> options mappings. Per-provider model-name
 * and URL env reads stay decentralized by existing design; this is only for the numbers.
 *
 * Responsible for: numeric + flag env-var reads with one unset/blank/non-finite fallback policy.
 * Not for: JSON config files - boot/config.ts owns those.
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

/** The positive whole-millisecond value of `env[name]`, or undefined when it is unset, blank,
 *  malformed, zero, or negative (fractions truncate). Injectable: pure over the given env, so
 *  env -> options mappings (lsp/host-runtime) stay unit-testable without touching process.env. */
export function envPositiveMs(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  const value = Math.trunc(Number(raw));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
