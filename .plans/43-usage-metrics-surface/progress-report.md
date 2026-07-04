# Usage Metrics Surface - Progress Report

## Summary

- **Current cutoff blockers:** 0
- **Completed current work:** 11
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** Done - all milestones landed

## Completed Current State / Hard Dependencies

- [x] D-065 owns model/provider/thinking selection and catalog state.
- [x] `.plans/13-telemetry-observability` owns telemetry and diagnostic artifacts.
- [x] Provider/run lifecycle events exist as the likely source.

## Completed Work

### M1 - Metrics Contract

- [x] RED: Define tested read models for run, session, provider/source, and time-window metrics.
      (`packages/session/src/metrics.ts`: `SegmentUsage`, `TurnUsage`, `UsageTotals`, `ProviderUsage`,
      `ModelUsage`, `IncidentRow`, `SessionUsage`, `UsageWindow`; pinned in `metrics.test.ts`.)
- [x] GREEN: Map available usage fields and explicitly mark unknown/untrusted fields.
      (`samples`/`trusted` per segment + turn; `input` reported as a peak, never summed; a
      no-usage turn is `trusted: false` with zeroed figures.)
- [x] REFACTOR: Keep metrics separate from settings and routing. (Pure read model, no write side,
      never influences model selection.)

### M2 - Collection and Aggregation

- [x] RED: Cover aggregation, redaction, missing data, and provider differences.
- [x] GREEN: Implement bounded aggregation over recorded run/provider events. (`collectTurns` +
      `aggregateUsage`/`sessionUsage`; cardinality bounded by ids/enum + a per-turn segment cap.)
- [x] RED: Cover per-model-segment attribution within a turn - usage, latency, and token/cost split at
      each `model.switched` boundary. (Explicit mid-turn-switch test asserts the 25/30 output split.)
- [x] GREEN: Partition each turn's recorded run/provider events at `model.switched` and aggregate usage
      per model/reasoning segment. (Cumulative-usage deltas from `assistant.progress`/`assistant.completed`
      split at each applied switch; a blocked switch opens no segment.)
- [x] REFACTOR: Reuse telemetry artifacts without making debug metrics user-blocking. (Derived from the
      durable log the store already keeps - no new persistence, nothing to block on.)

### M3 - UI and Export

- [x] RED: Storybook/test summary, provider breakdown, failure/retry rows, empty states, and export/copy.
      (`usage-summary.test.tsx` + `usage-summary.stories.tsx`.)
- [x] GREEN: Add the UI surface and optional export. (`apps/web/src/components/usage/usage-summary.tsx`
      with a copy button over `formatUsageReport`.)
- [x] REFACTOR: Keep cost/token labels conservative and source-attributed. (Provider-reported tokens
      only; `~` marks any total folding an unmeasured turn; input labelled a peak; no cost estimate.)

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.
