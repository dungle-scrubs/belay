/**
 * Canonical JSON for hashing (plan 25 simplify pass; hoisted from hooks/trust.ts and
 * agent/tool-guardrails.ts, which each carried a private copy). Object keys are sorted
 * recursively by CODE UNIT (`Array.prototype.sort` default) - never `localeCompare`, whose
 * ICU-dependent ordering could make the same bytes hash differently across locales. Any two
 * structurally equal values therefore serialize to identical bytes on every machine, which is
 * what makes trust fingerprints and guardrail signatures byte-stable.
 *
 * Responsible for: the recursively key-sorted JSON serialization hashing inputs go through.
 * Not for: hashing itself (callers pick the digest) or tolerant decoding (./decode).
 */

/** JSON.stringify with recursively code-unit-sorted object keys; property order never matters. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}
