import type {
  CapabilityManifest,
  ManifestHostInfo,
  ManifestItem,
  ManifestMetaValue,
  ManifestSection,
  ManifestSectionId,
} from "./capability-manifest";
import { renderCompactManifest } from "./capability-manifest-compact";
import { redactAttributeValue } from "./telemetry-contract";

/**
 * The `trevor-export` FORMATTER (plan 14, M6). It turns a built {@link CapabilityManifest} into the export
 * variants the command/API serves - full human text, the compact prompt block, machine JSON, and
 * section-scoped slices - and it owns the final REDACTION pass. Formatting lives here, deliberately apart
 * from manifest construction (M6 REFACTOR): the builder composes structured data; this module decides how it
 * is rendered and guarantees nothing sensitive leaves the host.
 *
 * Every variant is redacted through {@link redactManifest} first - defense in depth. Sections are built from
 * already-safe registry metadata, but a final scrub of every string field means a stray path or secret can
 * never ride out in an export, whatever a provider did upstream.
 */

export type ExportFormat = "text" | "json";

export interface ManifestExportRequest {
  readonly format: ExportFormat;
  /** `full` = every section with items; `compact` = the budgeted prompt block. Text formats only. */
  readonly detail: "full" | "compact";
  /** Restrict the export to a single section. */
  readonly section?: ManifestSectionId;
}

/** Cap for the full human-text export; past it the text is cut with an explicit note. */
const MAX_TEXT_CHARS = 40_000;

function redactMeta(
  meta: Readonly<Record<string, ManifestMetaValue>> | undefined,
): Readonly<Record<string, ManifestMetaValue>> | undefined {
  if (!meta) {
    return undefined;
  }
  const out: Record<string, ManifestMetaValue> = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = typeof value === "string" ? redactAttributeValue(value) : value;
  }
  return out;
}

function redactItem(item: ManifestItem): ManifestItem {
  const meta = redactMeta(item.meta);
  return {
    // id is a stable registry identifier (tool/command/skill name), not sensitive - kept verbatim.
    id: item.id,
    label: redactAttributeValue(item.label),
    ...(item.summary !== undefined ? { summary: redactAttributeValue(item.summary) } : {}),
    ...(item.scope !== undefined ? { scope: item.scope } : {}),
    ...(meta !== undefined ? { meta } : {}),
  };
}

function redactSection(section: ManifestSection): ManifestSection {
  return {
    ...section,
    title: redactAttributeValue(section.title),
    items: section.items.map(redactItem),
    ...(section.note !== undefined ? { note: redactAttributeValue(section.note) } : {}),
  };
}

function redactHost(host: ManifestHostInfo): ManifestHostInfo {
  return {
    ...(host.version !== undefined ? { version: redactAttributeValue(host.version) } : {}),
    ...(host.build !== undefined ? { build: redactAttributeValue(host.build) } : {}),
    ...(host.protocol !== undefined ? { protocol: host.protocol } : {}),
  };
}

/**
 * Scrubs every free-text field of a manifest (section titles/notes, item labels/summaries, string meta
 * values, workspace/host strings) through the shared secret/path redactor. Structure, ids, and numeric
 * facts are preserved. The final trust boundary before a manifest leaves the host.
 */
export function redactManifest(manifest: CapabilityManifest): CapabilityManifest {
  return {
    ...manifest,
    sections: manifest.sections.map(redactSection),
    ...(manifest.host ? { host: redactHost(manifest.host) } : {}),
    ...(manifest.workspace?.root !== undefined
      ? { workspace: { root: redactAttributeValue(manifest.workspace.root) } }
      : {}),
  };
}

/** Narrows a manifest to a single section (for `--section` exports); keeps the envelope + metadata. */
function selectSection(manifest: CapabilityManifest, id: ManifestSectionId): CapabilityManifest {
  return { ...manifest, sections: manifest.sections.filter((s) => s.id === id) };
}

/** Renders one section as a human-readable block: a header with count/status, then one line per item. */
function renderSectionBlock(section: ManifestSection): string {
  const shown = section.items.length;
  const total = section.total ?? shown;
  const countLabel = total > shown ? `${total}, showing ${shown}` : `${total}`;
  const pointer = section.detail && total > shown ? ` [more via ${section.detail}]` : "";
  if (section.status === "unavailable" || section.status === "error") {
    return `## ${section.title}: ${section.status}${section.note ? ` (${section.note})` : ""}`;
  }
  if (shown === 0) {
    return `## ${section.title}: none`;
  }
  const lines = section.items.map((item) => {
    const flags = item.meta
      ? Object.entries(item.meta)
          .map(([k, v]) => (v === true ? k : `${k}=${v}`))
          .join(" ")
      : "";
    const summary = item.summary ? ` - ${item.summary}` : "";
    const scope = item.scope ? ` (${item.scope})` : "";
    return `- ${item.label}${scope}${summary}${flags ? ` [${flags}]` : ""}`;
  });
  return `## ${section.title} (${countLabel})${pointer}\n${lines.join("\n")}`;
}

/** Renders the full human-readable manifest, capped at {@link MAX_TEXT_CHARS} with an explicit cut note. */
function renderFullManifest(manifest: CapabilityManifest): string {
  const head = [
    `Trevor capability manifest (scope: ${manifest.scope}, generated ${manifest.generatedAt})`,
    `schema v${manifest.version}${manifest.truncated ? " · some sections truncated" : ""}`,
  ];
  const blocks = manifest.sections.map(renderSectionBlock);
  const text = [...head, "", ...blocks].join("\n");
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}\n… output capped - use --json or --section for detail.`
    : text;
}

/**
 * Renders a manifest to the requested export variant, redaction applied first. `json` returns stable
 * pretty JSON; text `full` returns the human manifest; text `compact` returns the budgeted prompt block
 * (which itself refuses a non-prompt scope). A `section` narrows any variant to one section.
 */
export function renderManifestExport(
  manifest: CapabilityManifest,
  request: ManifestExportRequest,
): string {
  const scoped = request.section ? selectSection(manifest, request.section) : manifest;
  const safe = redactManifest(scoped);
  if (request.format === "json") {
    return JSON.stringify(safe, null, 2);
  }
  return request.detail === "compact" ? renderCompactManifest(safe) : renderFullManifest(safe);
}
