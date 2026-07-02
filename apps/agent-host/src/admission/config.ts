import { asPositiveInt } from "@host/boot/coerce";
import { loadJsonConfig } from "@host/boot/config";
import { envNumber } from "@host/boot/env";
import { USER_ADMISSION_JSON } from "@host/boot/paths";
import { ADMISSION_DEFAULT_CAPACITY, ADMISSION_STALE_MS } from "./store";

/**
 * User-owned local-admission config (plan 11 M8): the conservative default is one active generation per
 * resource (D-003), but a runtime PROVEN to handle more can be raised explicitly - per resource key or
 * as a new default - in a hand-edited `<TREVOR_HOME>/admission.json`, mirroring how `models.json` carries
 * per-model overrides. Capacity must be opted into; it is never inferred. The stale-owner TTL is tunable
 * the same way. Pure decoder + resolver, so parsing + precedence are unit-tested without disk or env.
 */

export interface AdmissionConfig {
  /** Active capacity for any resource without a specific override (default {@link ADMISSION_DEFAULT_CAPACITY}). */
  readonly defaultCapacity: number;
  /** Heartbeat-age staleness window in ms (default {@link ADMISSION_STALE_MS}). */
  readonly staleAfterMs: number;
  /** Per-resource-key capacity overrides (the full `local-provider:...` / `local-provider-lifecycle:...` key). */
  readonly capacityByResource: Readonly<Record<string, number>>;
}

/** The built-in defaults when no `admission.json` (and no env override) is present. */
export const DEFAULT_ADMISSION_CONFIG: AdmissionConfig = {
  defaultCapacity: ADMISSION_DEFAULT_CAPACITY,
  staleAfterMs: ADMISSION_STALE_MS,
  capacityByResource: {},
};

/**
 * Tolerantly decodes a raw `admission.json` value, keeping only well-formed fields (a positive integer
 * capacity / TTL; positive-integer per-resource overrides) and silently dropping anything else, so one
 * bad entry never discards the rest. Pure.
 */
export function parseAdmissionConfig(raw: unknown): AdmissionConfig {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_ADMISSION_CONFIG;
  }
  const r = raw as Record<string, unknown>;
  const capacityByResource: Record<string, number> = {};
  if (typeof r.capacityByResource === "object" && r.capacityByResource !== null) {
    for (const [key, value] of Object.entries(r.capacityByResource as Record<string, unknown>)) {
      const cap = asPositiveInt(value);
      if (cap !== undefined) {
        capacityByResource[key] = cap;
      }
    }
  }
  return {
    defaultCapacity: asPositiveInt(r.defaultCapacity) ?? ADMISSION_DEFAULT_CAPACITY,
    staleAfterMs: asPositiveInt(r.staleAfterMs) ?? ADMISSION_STALE_MS,
    capacityByResource,
  };
}

/**
 * Loads the effective admission config: the `admission.json` file (or defaults), with env overrides
 * (`TREVOR_ADMISSION_CAPACITY`, `TREVOR_ADMISSION_STALE_MS`) layered on top for an ops-level knob. `read`
 * + the env getters are injectable so the load is unit-tested without disk or `process.env`.
 */
export function loadAdmissionConfig(
  opts: {
    readonly read?: (path: string) => string;
    readonly capacityOverride?: number;
    readonly staleOverride?: number;
  } = {},
): AdmissionConfig {
  const file = loadJsonConfig(
    USER_ADMISSION_JSON,
    parseAdmissionConfig,
    DEFAULT_ADMISSION_CONFIG,
    opts.read,
  );
  const capacityOverride =
    opts.capacityOverride ?? envNumber("TREVOR_ADMISSION_CAPACITY", undefined);
  const staleOverride = opts.staleOverride ?? envNumber("TREVOR_ADMISSION_STALE_MS", undefined);
  return {
    defaultCapacity:
      capacityOverride && capacityOverride > 0 ? capacityOverride : file.defaultCapacity,
    staleAfterMs: staleOverride && staleOverride > 0 ? staleOverride : file.staleAfterMs,
    capacityByResource: file.capacityByResource,
  };
}

/** A resolver from a resource key to its configured capacity (per-resource override, else the default). */
export function capacityResolver(config: AdmissionConfig): (key: string) => number {
  return (key) => config.capacityByResource[key] ?? config.defaultCapacity;
}
