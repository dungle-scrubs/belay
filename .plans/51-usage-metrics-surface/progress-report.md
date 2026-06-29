# Usage Metrics Surface - Progress Report

## Summary

- **Current cutoff blockers:** 9
- **Completed current work:** 3
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M1 - Metrics Contract

## Completed Current State / Hard Dependencies

- [x] D-065 owns model/provider/thinking selection and catalog state.
- [x] `.plans/16-telemetry-observability` owns telemetry and diagnostic artifacts.
- [x] Provider/run lifecycle events exist as the likely source.

## Current Cutoff Blockers

- [ ] RED: Define tested read models for run, session, provider/source, and time-window metrics.
- [ ] GREEN: Map available usage fields and explicitly mark unknown/untrusted fields.
- [ ] REFACTOR: Keep metrics separate from settings and routing.
- [ ] RED: Cover aggregation, redaction, missing data, and provider differences.
- [ ] GREEN: Implement bounded aggregation over recorded run/provider events.
- [ ] REFACTOR: Reuse telemetry artifacts without making debug metrics user-blocking.
- [ ] RED: Storybook/test summary, provider breakdown, failure/retry rows, empty states, and export/copy.
- [ ] GREEN: Add the UI surface and optional export.
- [ ] REFACTOR: Keep cost/token labels conservative and source-attributed.

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.
