import type { CapabilityManifest, ManifestScope } from "@trevor/session";

/**
 * The registration seam for "build the current capability manifest" (plan 14, M6/M8). Mirrors
 * `doctor/source.ts`: main.ts registers ONE accessor at startup - a closure over its live singletons
 * (tool + command + skill + agent registries, the catalog snapshot, the doctor snapshot, runtime facts) -
 * and both the `/trevor-export` command and the built-in `trevor-expert` read the manifest through
 * {@link currentManifest} without importing the host's heavy wiring. A TYPE-only leaf module, so the
 * consumers can depend on it with no cycle back into main.ts.
 *
 * Responsible for: the registerManifestSource / currentManifest seam that decouples manifest
 * consumers from the host's live wiring.
 * Not for: building the manifest - the registered accessor (main.ts via build.ts) does that.
 */

/** Produces a freshly composed manifest at `scope` from the host's live state. */
export type ManifestSource = (scope: ManifestScope) => Promise<CapabilityManifest>;

let source: ManifestSource | undefined;

/** Wires the live manifest accessor (called once by the host on startup). */
export function registerManifestSource(fn: ManifestSource): void {
  source = fn;
}

/** Composes the current manifest at `scope`, or null when no source is wired (not the live host). */
export async function currentManifest(scope: ManifestScope): Promise<CapabilityManifest | null> {
  if (!source) {
    return null;
  }
  return source(scope);
}
