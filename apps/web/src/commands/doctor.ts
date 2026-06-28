/**
 * The `/doctor` health-snapshot read model is now owned by `@trevor/session` (so the HOST builds the
 * exact `DoctorSnapshot` the web dashboard renders, D-073). This module re-exports it under the
 * stable web-local path the dashboard components already import.
 */
export {
  DOCTOR_AREA_ORDER,
  DOCTOR_STATUS_HEADLINE,
  DOCTOR_STATUS_RANK,
  type DoctorArea,
  type DoctorAreaId,
  type DoctorFact,
  type DoctorFinding,
  type DoctorHostContext,
  type DoctorNextAction,
  type DoctorSnapshot,
  type DoctorSnapshotState,
  type DoctorStatus,
  type DoctorSummary,
  formatDoctorReport,
  isIssue,
  overallStatus,
  rollupStatus,
  summarizeSnapshot,
} from "@trevor/session";
