# Session Manager Residual - Implementation Plan

## 0. Hard Dependencies

- [x] D-085 project launcher is completed/tracked in the done report.
- [x] D-090 explicit resume is completed/tracked in the done report.
- [x] D-093 session navigation sidebar is tracked in the live progress report.
- [x] D-094 session lifecycle controls are tracked in the live progress report.
- [x] `.plans/26-archive-browser-and-delete` owns archive browser and permanent delete.
- [x] `.plans/10.1-managed-worktree-hardening` owns remaining D-091 hardening.

## Scope

Extracted from residual D-061. Most concrete session-manager slices already live elsewhere. This plan starts with a rebaseline: identify only the leftover browser-created folder session and launcher/supervisor lifecycle gaps that are not already owned by D-085, D-090, D-093, D-094, D-091/48, or archive-browser plans.

## Phases

### M1 - Residual Scope Audit

- [ ] RED: Add a checklist mapping every D-061 clause to an owning plan or residual gap.
- [ ] GREEN: Remove duplicated scope and keep only unowned session-manager gaps.
- [ ] REFACTOR: Update this plan with the narrowed residual scope before implementation.

### M2 - Browser-Created Folder Sessions

- [ ] RED: Cover folder selection/request, host launch/reuse, `host.online`, and navigation.
- [ ] GREEN: Implement browser-created session flow through the existing launcher/supervisor boundary.
- [ ] REFACTOR: Preserve Richter-only browser/host communication.

### M3 - Supervisor Lifecycle Glue

- [ ] RED: Cover no-host session selection, stale host, failed launch, and explicit retry.
- [ ] GREEN: Fill residual launcher/supervisor gaps not owned by D-085/D-090.
- [ ] REFACTOR: Keep lifecycle controls aligned with D-094.

## Decisions

Canonical decisions are in `.plans/52-session-manager-residual/plan.db`.
