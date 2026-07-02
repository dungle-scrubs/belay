import type { DoctorSnapshot } from "@trevor/session";

/**
 * The registration seam for "build the current /doctor snapshot" (D-073 M6).
 *
 * The `/doctor` command receives its live facts through the command registry's CommandContext, but a
 * model-facing tool (`tools/doctor.ts`) is a static module-level definition and never gets that
 * context. So the host (main.ts) registers ONE accessor here at startup - a closure over its live
 * singletons (providers, internet monitor, turn machine, git) that produces the same snapshot the
 * command does - and the `doctor` tool reads it through {@link currentDoctorSnapshot}. Keeping this a
 * leaf module (a TYPE-only import, no runtime edges) means the tools graph can depend on it without a
 * cycle back into the host's heavy provider/observation wiring.
 *
 * Responsible for: the registration seam giving the doctor tool the live snapshot builder.
 * Not for: building the snapshot - build.ts does; main.ts registers it here.
 */

/** Produces a fresh, sanitized `doctor.current` snapshot from the host's live state. */
export type DoctorSnapshotSource = () => Promise<DoctorSnapshot>;

let source: DoctorSnapshotSource | undefined;

/** Wires the live snapshot accessor (called once by the host on startup). */
export function registerDoctorSnapshotSource(fn: DoctorSnapshotSource): void {
  source = fn;
}

/**
 * Builds the current host-health snapshot. Throws if the host has not registered a source yet - in
 * practice it is registered at startup before any turn runs, so the `doctor` tool always resolves;
 * the throw turns a genuinely unwired host into one clean `error:` line rather than a silent empty
 * report.
 */
export async function currentDoctorSnapshot(): Promise<DoctorSnapshot> {
  if (!source) {
    throw new Error("doctor snapshot source is not registered on this host");
  }
  return source();
}
