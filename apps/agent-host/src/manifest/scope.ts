import type { ManifestScope } from "@trevor/session";

/**
 * Scope policy shared by every manifest section adapter (plan 14, M3). The manifest scope decides how
 * much a reader sees: the `human`/`client` views are the FULL debug/UI surface (hidden, debug, and
 * non-available capabilities are shown, tagged by scope), while the prompt-facing `compact`/`subagent`/
 * `expert` views drop those and cap counts to protect the token budget. Centralizing the policy keeps
 * every section consistent - a capability is never visible in one section's compact view but hidden in
 * another's. Body/truncation/provenance helpers live next door in section-helpers.ts.
 */

/** The full-fidelity scopes that surface hidden/debug/non-available capabilities (tagged, not dropped). */
export function scopeShowsHidden(scope: ManifestScope): boolean {
  return scope === "human" || scope === "client";
}

/** Per-section item cap for a scope. Full scopes get a generous cap; prompt scopes stay tight. */
export function scopeItemCap(scope: ManifestScope): number {
  return scopeShowsHidden(scope) ? 200 : 25;
}
