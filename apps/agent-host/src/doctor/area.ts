import {
  type DoctorArea,
  type DoctorAreaId,
  type DoctorFinding,
  type DoctorStatus,
  rollupStatus,
} from "@belay/session";

/**
 * The shared DoctorArea constructor for the /doctor area builders: rolls an area's findings into its
 * header status (any error wins, then warn, then ok) and assembles the area shape, with an explicit
 * status override for binary areas (e.g. internet) that carry warn/ok without a redundant finding
 * row.
 *
 * Responsible for: the shared area() constructor and its findings-to-status rollup.
 * Not for: any specific area's facts/findings - the areas-* modules build those.
 */

/** Rolls an area's findings into its header status (any error wins, then warn, then ok). */
function areaStatus(findings: readonly DoctorFinding[]): DoctorStatus {
  return rollupStatus(findings.map((f) => f.status));
}

export function area(
  id: DoctorAreaId,
  label: string,
  verdict: string,
  findings: readonly DoctorFinding[],
  facts?: DoctorArea["facts"],
  // Most areas roll their status up from their findings; a binary area (e.g. internet) sets it
  // directly so it can carry warn/ok without a redundant finding row.
  statusOverride?: DoctorStatus,
): DoctorArea {
  return {
    id,
    label,
    status: statusOverride ?? areaStatus(findings),
    verdict,
    findings,
    ...(facts ? { facts } : {}),
  };
}
