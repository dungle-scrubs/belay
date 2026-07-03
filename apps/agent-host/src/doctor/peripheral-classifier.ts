import type { PeripheralState } from "./probe-input";

type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

/**
 * Shared fold for doctor peripheral rollups.
 *
 * Responsible for: applying one configured-entry selection, then a precedence-ordered list of
 * classification rules, then the ready fallback.
 * Not for: reading runtime snapshots, formatting subsystem-specific details, or building extra
 * findings/debug summaries.
 */
export interface PeripheralClassificationRule<TEntry> {
  readonly when: (entry: TEntry) => boolean;
  readonly state: (
    matched: NonEmptyReadonlyArray<TEntry>,
    configured: NonEmptyReadonlyArray<TEntry>,
  ) => PeripheralState;
}

export function classifyPeripheral<TEntry>(
  entries: readonly TEntry[],
  opts: {
    readonly configured: (entry: TEntry) => boolean;
    readonly rules: readonly PeripheralClassificationRule<TEntry>[];
    readonly ready: (configured: NonEmptyReadonlyArray<TEntry>) => PeripheralState;
  },
): PeripheralState {
  const configured = entries.filter(opts.configured);
  if (configured.length === 0) {
    return { kind: "unconfigured" };
  }
  const configuredEntries = configured as unknown as NonEmptyReadonlyArray<TEntry>;

  for (const rule of opts.rules) {
    const matched = configuredEntries.filter(rule.when);
    if (matched.length > 0) {
      return rule.state(matched as unknown as NonEmptyReadonlyArray<TEntry>, configuredEntries);
    }
  }

  return opts.ready(configuredEntries);
}
