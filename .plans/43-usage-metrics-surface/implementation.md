# Usage Metrics Surface - Implementation Plan

## 0. Hard Dependencies

- [x] D-065 owns model/provider/thinking selection and catalog state.
- [x] `.plans/13-telemetry-observability` owns telemetry and diagnostic artifacts.
- [x] Provider/run events carry enough lifecycle context to attach usage data when available.
- [ ] `.plans/09.1-mid-turn-model-switch` lets one turn span multiple models/reasoning levels and records each change as a `model.switched` event; usage must be attributed per model segment within a turn, not one model per turn. <!-- D-002 -->

## Scope

Extracted from H-031/H-034. This plan owns a user-facing usage/metrics surface separate from model/provider settings. It should summarize run/session/provider usage, latency, token/cost estimates where trustworthy, retries/failures, and local/cloud/provider breakdowns. Because `.plans/09.1-mid-turn-model-switch` lets a single turn span multiple model/reasoning segments, per-turn usage breaks down per segment (split at each `model.switched`), not one model per turn. <!-- D-002 --> It is not a routing engine and must not silently affect model selection.

## Phases

### M1 - Metrics Contract

- [ ] RED: Define tested read models for run, session, provider/source, and time-window metrics.
- [ ] GREEN: Map available usage fields and explicitly mark unknown/untrusted fields.
- [ ] REFACTOR: Keep metrics separate from settings and routing.

### M2 - Collection and Aggregation

- [ ] RED: Cover aggregation, redaction, missing data, and provider differences.
- [ ] GREEN: Implement bounded aggregation over recorded run/provider events.
- [ ] RED: Cover per-model-segment attribution within a turn - usage, latency, and token/cost split at each `model.switched` boundary so a turn spanning multiple models/reasoning levels is not attributed to a single model.
- [ ] GREEN: Partition each turn's recorded run/provider events at `model.switched` events from `.plans/09.1-mid-turn-model-switch` and aggregate usage per model/reasoning segment.
- [ ] REFACTOR: Reuse telemetry artifacts without making debug metrics user-blocking.

### M3 - UI and Export

- [ ] RED: Storybook/test summary, provider breakdown, failure/retry rows, empty states, and export/copy.
- [ ] GREEN: Add the UI surface and optional export.
- [ ] REFACTOR: Keep cost/token labels conservative and source-attributed.

## Decisions

Canonical decisions are in `.plans/43-usage-metrics-surface/plan.db`.
