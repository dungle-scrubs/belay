import { CHARS_PER_TOKEN } from "./breakdown";
import type { CapabilityManifest, ManifestScope, ManifestSection } from "./capability-manifest";

/**
 * The COMPACT manifest projection (plan 14, M5): turns a structured {@link CapabilityManifest} into the
 * terse, token-budgeted text a subagent or the built-in `belay-expert` gets in its context. The prompt
 * text is GENERATED from the manifest object, never hand-written prose (M5 REFACTOR) - so it can never
 * drift from the real capability surface.
 *
 * Two guardrails:
 *  - A FULL (human/client) manifest is export-only. {@link renderCompactManifest} refuses to render one, so
 *    the heavyweight manifest can never be injected into a turn (M5: normal turns never get the full form).
 *  - The output is bounded by a token budget. Sections are emitted in canonical priority order and dropped
 *    from the tail when the budget runs out, with an explicit "omitted" note - never a silent cut.
 */

/** How many item labels to preview per section line before eliding to a count. */
const ITEM_PREVIEW = 5;
/** Default compact budget (tokens) - small enough to ride along in a subagent/expert context. */
const DEFAULT_MAX_TOKENS = 600;
/** Token headroom reserved for the trailing "… N more section(s) omitted …" note (~65 chars = ~17 tokens). */
const OMITTED_NOTE_RESERVE = 18;

/** Rough token estimate for a rendered manifest block, using the shared {@link CHARS_PER_TOKEN} proxy.
 *  Rounds UP (unlike the metrics `estimateTokens`): this budget is a guardrail, so it errs conservative. */
export function estimateManifestTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * The scopes a compact manifest may be rendered INTO a prompt for. The full `human`/`client` views are
 * export-only and must never be injected into a turn.
 */
export function isPromptScope(scope: ManifestScope): boolean {
  return scope === "compact" || scope === "subagent" || scope === "expert";
}

export interface CompactRenderOptions {
  /** Token budget for the whole block; sections past it are dropped with an explicit note. Default 600. */
  readonly maxTokens?: number;
}

/** Renders one section as a single compact line from its structured fields (never free prose). */
function renderSectionLine(section: ManifestSection): string {
  if (section.status === "unavailable") {
    return `- ${section.title}: unavailable${section.note ? ` (${section.note})` : ""}`;
  }
  if (section.status === "error") {
    return `- ${section.title}: error${section.note ? ` (${section.note})` : ""}`;
  }
  if (section.items.length === 0) {
    return `- ${section.title}: none`;
  }
  const preview = section.items.slice(0, ITEM_PREVIEW).map((i) => i.label);
  const total = section.total ?? section.items.length;
  const elided = total - preview.length;
  const more = elided > 0 ? `, +${elided} more` : "";
  const pointer = section.detail && elided > 0 ? ` [more via ${section.detail}]` : "";
  return `- ${section.title} (${total}): ${preview.join(", ")}${more}${pointer}`;
}

/**
 * Renders a compact/subagent/expert manifest to a bounded prompt-text block. Throws if handed a full
 * (human/client) manifest - the full form is export-only and must never reach a turn. Emits sections in
 * canonical order, dropping from the tail when the token budget is exhausted and noting how many were
 * omitted plus where to get them.
 */
export function renderCompactManifest(
  manifest: CapabilityManifest,
  options: CompactRenderOptions = {},
): string {
  if (!isPromptScope(manifest.scope)) {
    throw new Error(
      `refusing to render a "${manifest.scope}"-scope manifest as prompt text: the full manifest is export-only`,
    );
  }
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const header = "Belay capabilities (compact - use belay-export for detail):";
  const lines: string[] = [header];
  let omitted = 0;
  for (const section of manifest.sections) {
    const line = renderSectionLine(section);
    // Reserve room for the trailing "omitted" note (bounded: a two-digit count + fixed text) so appending
    // it can never push the final block past the budget.
    if (estimateManifestTokens([...lines, line].join("\n")) > maxTokens - OMITTED_NOTE_RESERVE) {
      omitted = manifest.sections.length - manifest.sections.indexOf(section);
      break;
    }
    lines.push(line);
  }
  if (omitted > 0) {
    lines.push(`… ${omitted} more section(s) omitted for space - use belay-export.`);
  }
  return lines.join("\n");
}
