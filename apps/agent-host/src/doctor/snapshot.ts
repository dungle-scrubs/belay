import type { DoctorSnapshot } from "@belay/session";
import { internetArea, peripheralArea, webDocsArea } from "./areas-connectivity";
import { coreArea, sessionArea, toolsArea, workspaceArea } from "./areas-host";
import { admissionArea, storageArea, telemetryArea, updatesArea } from "./areas-platform";
import { providersArea } from "./areas-providers";
import { lspDiagnosticFinding } from "./lsp-status";
import type { DoctorProbeInput } from "./probe-input";

/**
 * Builds the structured `doctor.current` snapshot (D-073) from already-probed host facts. PURE over
 * its input so the area/finding/severity construction is deterministic and unit-testable; the
 * command handler owns the bounded, redacted probing (provider readiness, storage writeability) and
 * feeds the results here. The input contract lives in probe-input.ts and the per-area folds in the
 * areas-* modules; this module fixes the grid - which areas exist and in what order. Areas the first
 * cut does not probe (web/docs, MCP, LSP, hooks, updates) are reported `not_checked` rather than
 * omitted, so the dashboard always shows the full grid.
 *
 * This is health + repair guidance, NOT raw runtime internals (that stays in host.debugInfo): every
 * value here is a sanitized fact, and findings carry a next action where one applies.
 *
 * Responsible for: assembling the full doctor snapshot - the area grid and its order.
 * Not for: probing or IO - build.ts - or the per-area folds - the areas-* modules.
 */

/** The LSP area's extra findings: the diagnostic-warning when stored errors are present. */
function lspAreaFindings(input: DoctorProbeInput) {
  const finding = lspDiagnosticFinding(input.lspDiagnostics);
  return finding ? [finding] : [];
}

export function buildDoctorSnapshot(input: DoctorProbeInput): DoctorSnapshot {
  return {
    state: "ready",
    checkedAt: input.checkedAt,
    host: {
      workspace: input.workspace.workspace,
      instanceId: input.host.instanceId,
      role: input.host.role,
    },
    areas: [
      coreArea(input),
      sessionArea(input),
      providersArea(input),
      internetArea(input),
      toolsArea(input),
      webDocsArea(input),
      peripheralArea("mcp", "MCP", input.peripherals.mcp),
      // The LSP area carries the diagnostic-warning finding (plan 24 M8, D-008) on top of its
      // lifecycle state: stored diagnostics WITH errors roll the area to warn.
      peripheralArea("lsp", "LSP", input.peripherals.lsp, lspAreaFindings(input)),
      // The Hooks area carries its approval/script/performance/legacy findings (plan 25 M9,
      // D-009) on top of its lifecycle state, the same shape as the LSP diagnostic-warning.
      peripheralArea("hooks", "Hooks", input.peripherals.hooks, input.hooksFindings ?? []),
      storageArea(input),
      workspaceArea(input),
      admissionArea(input),
      telemetryArea(input),
      updatesArea(input),
    ],
  };
}
