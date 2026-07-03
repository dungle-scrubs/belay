/**
 * Responsible for: the redacted context-observability read model (D-012) - folding a rendered
 * ContextReport plus the CLAUDE.md migration inventory into counts the doctor / debug surface can show
 * WITHOUT dumping any instruction or rule body. It distinguishes AGENTS.md from `.trevor/rules`, counts
 * rule inclusion reasons, and separates detected CLAUDE.md into pointers, still-to-migrate, and ignored,
 * surfacing bytes used/dropped and the required-response state.
 * Not for: reading the filesystem (callers pass the report + inventory) or the proposal flow itself.
 */
import { commas } from "@host/transport/messages";
import type { ContextReport } from "./agents-md";
import type { ClaudeMigrationInventory } from "./claude-migration";

/** A count-only, body-free summary of the loaded project context and pending migrations. */
export interface ContextDiagnostics {
  readonly agentsFiles: number;
  readonly scopes: readonly string[];
  readonly rulesTotal: number;
  readonly rulesAlways: number;
  readonly rulesScoped: number;
  readonly bytesUsed: number;
  readonly bytesDropped: number;
  readonly truncated: boolean;
  readonly claudeDetected: number;
  readonly claudePointers: number;
  readonly claudeToMigrate: number;
  readonly claudeIgnored: number;
  /** True when a non-pointer, non-ignored CLAUDE.md still awaits a required-response decision. */
  readonly requiredResponsePending: boolean;
}

/**
 * Fold the rendered context report + migration inventory into count-only diagnostics. AGENTS.md files
 * are the ingested sources that are NOT `.trevor/rules` (the rule paths come from the report's separate
 * rule accounting); CLAUDE.md files are split into pointers, ignored, and the remainder that still needs
 * a proposal.
 */
export function collectContextDiagnostics(
  report: ContextReport,
  inventory: ClaudeMigrationInventory,
  ignored: ReadonlySet<string>,
): ContextDiagnostics {
  const rulePaths = new Set(report.ruleSources.map((rule) => rule.path));
  const agentsFiles = report.files.filter((file) => !rulePaths.has(file)).length;
  const rulesAlways = report.ruleSources.filter((rule) => rule.inclusionReason === "always").length;

  const pointers = inventory.items.filter((item) => item.pointer).length;
  const ignoredCount = inventory.items.filter((item) => ignored.has(item.claudePath)).length;
  const toMigrate = inventory.items.filter(
    (item) => item.needsProposal && !ignored.has(item.claudePath),
  ).length;

  return {
    agentsFiles,
    scopes: report.scopes,
    rulesTotal: report.ruleSources.length,
    rulesAlways,
    rulesScoped: report.ruleSources.length - rulesAlways,
    bytesUsed: report.bytesUsed,
    bytesDropped: report.bytesDropped,
    truncated: report.truncated,
    claudeDetected: inventory.items.length,
    claudePointers: pointers,
    claudeToMigrate: toMigrate,
    claudeIgnored: ignoredCount,
    requiredResponsePending: toMigrate > 0,
  };
}

/**
 * Render the diagnostics into the doctor's `Record<string,string>` debug lines: one `context` line
 * (AGENTS.md + rules + scopes + bytes, with any truncation), and a `claudeMd` line ONLY when CLAUDE.md
 * files are detected (to-migrate + required-response state, pointers, ignored). Counts and scopes only -
 * never a body.
 */
export function formatContextDiagnostics(diag: ContextDiagnostics): Record<string, string> {
  if (diag.agentsFiles === 0 && diag.rulesTotal === 0 && diag.claudeDetected === 0) {
    return {};
  }

  const lines: Record<string, string> = {};

  if (diag.agentsFiles > 0 || diag.rulesTotal > 0) {
    const ruleSummary =
      diag.rulesTotal > 0
        ? `, ${diag.rulesTotal} rule${diag.rulesTotal === 1 ? "" : "s"} (${diag.rulesAlways} always, ${diag.rulesScoped} scoped)`
        : "";
    const scopes = diag.scopes.length > 0 ? ` [${diag.scopes.join(", ")}]` : "";
    const dropped = diag.truncated ? ` (-${commas(diag.bytesDropped)}B truncated)` : "";
    lines.context = `${diag.agentsFiles} AGENTS.md${ruleSummary}${scopes} ${commas(diag.bytesUsed)}B${dropped}`;
  }

  if (diag.claudeDetected > 0) {
    const parts: string[] = [];
    if (diag.claudeToMigrate > 0) {
      // The required-response flag is the collected state, not re-derived here, so the formatter and
      // any other consumer of ContextDiagnostics can never disagree on it.
      const pending = diag.requiredResponsePending ? " (response required)" : "";
      parts.push(`${diag.claudeToMigrate} to migrate${pending}`);
    }
    if (diag.claudePointers > 0) {
      parts.push(`${diag.claudePointers} pointer${diag.claudePointers === 1 ? "" : "s"}`);
    }
    if (diag.claudeIgnored > 0) {
      parts.push(`${diag.claudeIgnored} ignored`);
    }
    if (parts.length === 0) {
      parts.push("all migrated");
    }
    lines.claudeMd = `${diag.claudeDetected} CLAUDE.md: ${parts.join(", ")}`;
  }

  return lines;
}
