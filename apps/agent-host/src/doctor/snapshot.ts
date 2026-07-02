import type { DoctorSnapshot } from "@trevor/session";
import { internetArea, peripheralArea, webDocsArea } from "./areas-connectivity";
import { coreArea, sessionArea, toolsArea, workspaceArea } from "./areas-host";
import { admissionArea, storageArea, telemetryArea, updatesArea } from "./areas-platform";
import { providersArea } from "./areas-providers";
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
      peripheralArea("lsp", "LSP", input.peripherals.lsp),
      peripheralArea("hooks", "Hooks", input.peripherals.hooks),
      storageArea(input),
      workspaceArea(input),
      admissionArea(input),
      telemetryArea(input),
      updatesArea(input),
    ],
  };
}
