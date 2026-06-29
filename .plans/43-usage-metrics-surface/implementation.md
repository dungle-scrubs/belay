# Usage Metrics Surface - Implementation Plan

## 0. Hard Dependencies

- [x] D-065 owns model/provider/thinking selection and catalog state.
- [x] `.plans/13-telemetry-observability` owns telemetry and diagnostic artifacts.
- [x] Provider/run events carry enough lifecycle context to attach usage data when available.

## Scope

Extracted from H-031/H-034. This plan owns a user-facing usage/metrics surface separate from model/provider settings. It should summarize run/session/provider usage, latency, token/cost estimates where trustworthy, retries/failures, and local/cloud/provider breakdowns. It is not a routing engine and must not silently affect model selection.

## Phases

### M1 - Metrics Contract

- [ ] RED: Define tested read models for run, session, provider/source, and time-window metrics.
- [ ] GREEN: Map available usage fields and explicitly mark unknown/untrusted fields.
- [ ] REFACTOR: Keep metrics separate from settings and routing.

### M2 - Collection and Aggregation

- [ ] RED: Cover aggregation, redaction, missing data, and provider differences.
- [ ] GREEN: Implement bounded aggregation over recorded run/provider events.
- [ ] REFACTOR: Reuse telemetry artifacts without making debug metrics user-blocking.

### M3 - UI and Export

- [ ] RED: Storybook/test summary, provider breakdown, failure/retry rows, empty states, and export/copy.
- [ ] GREEN: Add the UI surface and optional export.
- [ ] REFACTOR: Keep cost/token labels conservative and source-attributed.

## Decisions

Canonical decisions are in `.plans/43-usage-metrics-surface/plan.db`.
