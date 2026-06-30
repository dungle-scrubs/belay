# Local Admission Control - Progress Report

## Summary

- **Current focus:** Complete - all 10 milestones implemented and verified
- **Completed:** 72 / 72
- **Current cutoff blockers:** 0
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0

## 0. Hard Dependencies

- [x] V2 LM Studio provider/client exists in `apps/agent-host/src/providers/lmstudio.ts` and `apps/agent-host/src/providers/lmstudio-client.ts`.
- [x] V2 LM Studio context warming currently dedupes only inside one provider instance through `LmStudioClient.ensureMaxContext()`.
- [x] V1 local admission provenance found in `/Users/kevin/dev/trevor/packages/agent-host/src/provider/local-admission.ts`.
- [x] V1 local admission tests found in `/Users/kevin/dev/trevor/packages/agent-host/test/provider/local-pi-ai-provider.test.ts`.
- [x] `03-filesystem-root-taxonomy` defines `TREVOR_HOME` for durable Trevor state, ownership records, and locks.
- [x] Parallel subagents and multi-project LM Studio usage make this a prerequisite for local-provider stability.

## Current Cutoff Blockers

### Phase 1: Contract and Provenance

#### M1: V1 Provenance Snapshot

- [x] RED: Add provenance tests or fixtures capturing V1 local admission reserved, queued, refused, released, active-budget refusal, alias collapse, and provider concurrency metadata behaviors.
- [x] GREEN: Document the V1 target-key, estimate, queue, release, and interaction-event contract as intended V2 behavior.
- [x] RED: Add V2 contract tests for provider/base URL/model keying and local-only admission.
- [x] GREEN: Define V2 local-admission types, resource keys, release reasons, refusal classes, and debug snapshots.
- [x] REFACTOR: Keep V1 provenance separate from V2's cross-process implementation boundary.

#### M2: Cross-Process Admission Contract

- [x] RED: Add contract tests for two independent host/admission clients contending for the same LM Studio resource.
- [x] GREEN: Define acquire, heartbeat, release, cancel, stale-reap, and snapshot operations.
- [x] RED: Add tests for priority ordering: foreground before recovery before command-backed before background/subagent before maintenance.
- [x] GREEN: Define priority assignment rules and FIFO ordering inside equal priority.
- [x] REFACTOR: Keep local admission independent from turn scheduling so it can protect subagents and future local-provider call sites.

#### Gate 1->2

- [x] V1 admission lessons are captured as provenance.
- [x] V2 has an explicit cross-process acquire/queue/release contract.
- [x] Priority classes and resource keys are specified.

### Phase 2: Shared Lease and Queue Store

#### M3: Shared Store and Atomic Leases

- [x] RED: Add integration tests using an isolated `TREVOR_HOME` where two admission clients cannot both acquire a capacity-1 resource.
- [x] GREEN: Implement shared store acquire/release with atomicity, owner metadata, capacity, and resource snapshots.
- [x] RED: Add tests for process crash/stale owner TTL and heartbeat refresh.
- [x] GREEN: Implement heartbeat and stale owner reaping without stealing a healthy active owner.
- [x] REFACTOR: Keep diagnostic writes best-effort and separate from durable coordination state.

#### M4: Queue, Priority, and Cancellation

- [x] RED: Add tests for queued acquire, queue position, FIFO within priority, and priority ordering across foreground/background work.
- [x] GREEN: Implement queue records and wake/drain behavior after release or stale reap.
- [x] RED: Add tests proving cancellation removes queued requests and releases active requests.
- [x] GREEN: Wire cancellation signals through queued and active reservations.
- [x] REFACTOR: Normalize failure modes for timeout, cancelled, stale-reaped, refused, and store-unavailable cases.

#### Gate 2->3

- [x] Cross-process capacity is enforced under an isolated `TREVOR_HOME`.
- [x] Queued requests wake deterministically in priority order.
- [x] Cancellation never leaves active or queued admission records behind.

### Phase 3: LM Studio Provider Integration

#### M5: Lifecycle Admission Around `ensureMaxContext`

- [x] RED: Add tests for two host processes attempting LM Studio context reload at the same time.
- [x] GREEN: Acquire the endpoint lifecycle resource before `lms unload` / `lms load` work.
- [x] RED: Add tests proving active generation prevents unsafe reload or makes reload wait behind active work.
- [x] GREEN: Coordinate lifecycle and generation resources so reloads do not race active streams.
- [x] REFACTOR: Surface lifecycle wait/reload state in `LmStudioClient.debugInfo()`.

#### M6: Generation Admission Around Local Streams

- [x] RED: Add provider tests proving two local streams for the same LM Studio resource serialize by default.
- [x] GREEN: Acquire generation admission before local pi-ai stream dispatch and release on success, failure, or cancellation.
- [x] RED: Add tests proving cloud providers and non-local providers bypass local admission.
- [x] GREEN: Scope admission to `kind: "local"` providers and concrete local target metadata.
- [x] REFACTOR: Preserve existing provider failure taxonomy and overflow behavior.

#### Gate 3->4

- [x] LM Studio load/reload operations are serialized safely.
- [x] LM Studio generation streams obey configured resource capacity.
- [x] Cloud providers are unaffected.

### Phase 4: User-Visible Waiting and Debuggability

#### M7: Transcript/Task Status

- [x] RED: Add protocol/read-model tests for queued, acquired, released, refused, and cancelled admission events.
- [x] GREEN: Emit bounded live status for "waiting for LM Studio", queue position, provider/model, and priority class.
- [x] RED: Add web/Storybook fixtures for foreground waiting, background subagent waiting, refused, and cancelled states.
- [x] GREEN: Render visible waiting state through existing task/transcript status patterns without permanent transcript noise.
- [x] REFACTOR: Reuse action shimmer/status primitives where available.

#### M8: Doctor, Config, and Metrics

- [x] RED: Add `/doctor` tests for active local owners, queue length, oldest wait, lifecycle lock, stale lock, and last refusal.
- [x] GREEN: Add doctor/debug snapshots for local admission.
- [x] RED: Add config tests for default LM Studio capacity 1 and explicit per-resource capacity overrides.
- [x] GREEN: Add preference/config parsing for local admission concurrency and TTL settings.
- [x] REFACTOR: Emit best-effort admission diagnostics under Trevor state without affecting turns when diagnostic writes fail.

#### Gate 4->5

- [x] Users can see why a local model turn or subagent is waiting.
- [x] Cancelling queued local work removes it from the queue.
- [x] `/doctor` explains local model ownership and queue state.

### Phase 5: E2E and Parallel Subagent Readiness

#### M9: Hermetic Multi-Process E2E

- [x] RED: Add hermetic e2e with two host processes/projects sharing an isolated fake LM Studio resource.
- [x] GREEN: Prove one process acquires while the other queues, then drains after release.
- [x] RED: Add crash/stale-lock e2e where the active owner disappears and the queued owner proceeds only after TTL.
- [x] GREEN: Implement robust cleanup and stale owner handling across process boundaries.
- [x] REFACTOR: Keep the e2e fake local provider reusable for future subagent tests.

#### M10: Parallel Subagent Load Test

- [x] RED: Add a host-level test where multiple background/subagent model calls target the same local LM Studio resource.
- [x] GREEN: Ensure background/subagent work queues behind foreground work and drains without starvation.
- [x] RED: Add tests for cancelling a parent run while subagent local-model requests are queued or active.
- [x] GREEN: Release queued and active reservations correctly across parent/subagent cancellation paths.
- [x] REFACTOR: Document local-model capacity guidance for future subagent/team plans.

#### Gate 5

- [x] Unit, integration, web, and hermetic e2e tests pass.
- [x] Two Trevor projects cannot overload the same LM Studio resource by default.
- [x] Parallel subagents queue predictably behind foreground local-model work.
- [x] Admission state is visible, cancellable, and inspectable.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.
