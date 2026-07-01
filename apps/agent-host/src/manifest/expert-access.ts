import {
  type ManifestExportRequest,
  type ManifestScope,
  renderManifestExport,
} from "@trevor/session";
import { currentManifest } from "./source";

/**
 * The built-in `trevor-expert`'s DIRECT export access (plan 14, M7/M8, D-004). The trusted built-in reads
 * the capability manifest straight from the host export seam ({@link currentManifest} + the shared
 * redacting renderer) - NOT through the general interpolation gate - so it works whether or not
 * `TREVOR_ENABLE_INTERPOLATION` is set. This is the one deliberate, justified bypass of the interpolation
 * boundary: the export is read-only, host-generated, scope-bounded, and already redacted.
 *
 * It never runs a shell, never mutates state, and never grants a permission - it composes and returns a
 * bounded description slice, or null when there is no live host to read from.
 */
export async function expertManifestExport(
  scope: ManifestScope,
  request: ManifestExportRequest,
): Promise<string | null> {
  const manifest = await currentManifest(scope);
  return manifest ? renderManifestExport(manifest, request) : null;
}
