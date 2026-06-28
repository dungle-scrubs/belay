# Local Admission Control - Progress Report

## Summary

- **Current focus:** M1 - V1 Provenance Snapshot
- **Completed:** 6 / 72
- **Current cutoff blockers:** 66
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

- [ ] RED: Add provenance tests or fixtures capturing V1 local admission reserved, queued, refused, released, active-budget refusal, alias collapse, and provider concurrency metadata behaviors.
- [ ] GREEN: Document the V1 target-key, estimate, queue, release, and interaction-event contract as intended V2 behavior.
- [ ] RED: Add V2 contract tests for provider/base URL/model keying and local-only admission.
- [ ] GREEN: Define V2 local-admission types, resource keys, release reasons, refusal classes, and debug snapshots.
- [ ] REFACTOR: Keep V1 provenance separate from V2's cross-process implementation boundary.

#### M2: Cross-Process Admission Contract

- [ ] RED: Add contract tests for two independent host/admission clients contending for the same LM Studio resource.
- [ ] GREEN: Define acquire, heartbeat, release, cancel, stale-reap, and snapshot operations.
- [ ] RED: Add tests for priority ordering: foreground before recovery before command-backed before background/subagent before maintenance.
- [ ] GREEN: Define priority assignment rules and FIFO ordering inside equal priority.
- [ ] REFACTOR: Keep local admission independent from turn scheduling so it can protect subagents and future local-provider call sites.

#### Gate 1->2

- [ ] V1 admission lessons are captured as provenance.
- [ ] V2 has an explicit cross-process acquire/queue/release contract.
- [ ] Priority classes and resource keys are specified.

### Phase 2: Shared Lease and Queue Store

#### M3: Shared Store and Atomic Leases

- [ ] RED: Add integration tests using an isolated `TREVOR_HOME` where two admission clients cannot both acquire a capacity-1 resource.
- [ ] GREEN: Implement shared store acquire/release with atomicity, owner metadata, capacity, and resource snapshots.
- [ ] RED: Add tests for process crash/stale owner TTL and heartbeat refresh.
- [ ] GREEN: Implement heartbeat and stale owner reaping without stealing a healthy active owner.
- [ ] REFACTOR: Keep diagnostic writes best-effort and separate from durable coordination state.

#### M4: Queue, Priority, and Cancellation

- [ ] RED: Add tests for queued acquire, queue position, FIFO within priority, and priority ordering across foreground/background work.
- [ ] GREEN: Implement queue records and wake/drain behavior after release or stale reap.
- [ ] RED: Add tests proving cancellation removes queued requests and releases active requests.
- [ ] GREEN: Wire cancellation signals through queued and active reservations.
- [ ] REFACTOR: Normalize failure modes for timeout, cancelled, stale-reaped, refused, and store-unavailable cases.

#### Gate 2->3

- [ ] Cross-process capacity is enforced under an isolated `TREVOR_HOME`.
- [ ] Queued requests wake deterministically in priority order.
- [ ] Cancellation never leaves active or queued admission records behind.

### Phase 3: LM Studio Provider Integration

#### M5: Lifecycle Admission Around `ensureMaxContext`

- [ ] RED: Add tests for two host processes attempting LM Studio context reload at the same time.
- [ ] GREEN: Acquire the endpoint lifecycle resource before `lms unload` / `lms load` work.
- [ ] RED: Add tests proving active generation prevents unsafe reload or makes reload wait behind active work.
- [ ] GREEN: Coordinate lifecycle and generation resources so reloads do not race active streams.
- [ ] REFACTOR: Surface lifecycle wait/reload state in `LmStudioClient.debugInfo()`.

#### M6: Generation Admission Around Local Streams

- [ ] RED: Add provider tests proving two local streams for the same LM Studio resource serialize by default.
- [ ] GREEN: Acquire generation admission before local pi-ai stream dispatch and release on success, failure, or cancellation.
- [ ] RED: Add tests proving cloud providers and non-local providers bypass local admission.
- [ ] GREEN: Scope admission to `kind: "local"` providers and concrete local target metadata.
- [ ] REFACTOR: Preserve existing provider failure taxonomy and overflow behavior.

#### Gate 3->4

- [ ] LM Studio load/reload operations are serialized safely.
- [ ] LM Studio generation streams obey configured resource capacity.
- [ ] Cloud providers are unaffected.

### Phase 4: User-Visible Waiting and Debuggability

#### M7: Transcript/Task Status

- [ ] RED: Add protocol/read-model tests for queued, acquired, released, refused, and cancelled admission events.
- [ ] GREEN: Emit bounded live status for "waiting for LM Studio", queue position, provider/model, and priority class.
- [ ] RED: Add web/Storybook fixtures for foreground waiting, background subagent waiting, refused, and cancelled states.
- [ ] GREEN: Render visible waiting state through existing task/transcript status patterns without permanent transcript noise.
- [ ] REFACTOR: Reuse action shimmer/status primitives where available.

#### M8: Doctor, Config, and Metrics

- [ ] RED: Add `/doctor` tests for active local owners, queue length, oldest wait, lifecycle lock, stale lock, and last refusal.
- [ ] GREEN: Add doctor/debug snapshots for local admission.
- [ ] RED: Add config tests for default LM Studio capacity 1 and explicit per-resource capacity overrides.
- [ ] GREEN: Add preference/config parsing for local admission concurrency and TTL settings.
- [ ] REFACTOR: Emit best-effort admission diagnostics under Trevor state without affecting turns when diagnostic writes fail.

#### Gate 4->5

- [ ] Users can see why a local model turn or subagent is waiting.
- [ ] Cancelling queued local work removes it from the queue.
- [ ] `/doctor` explains local model ownership and queue state.

### Phase 5: E2E and Parallel Subagent Readiness

#### M9: Hermetic Multi-Process E2E

- [ ] RED: Add hermetic e2e with two host processes/projects sharing an isolated fake LM Studio resource.
- [ ] GREEN: Prove one process acquires while the other queues, then drains after release.
- [ ] RED: Add crash/stale-lock e2e where the active owner disappears and the queued owner proceeds only after TTL.
- [ ] GREEN: Implement robust cleanup and stale owner handling across process boundaries.
- [ ] REFACTOR: Keep the e2e fake local provider reusable for future subagent tests.

#### M10: Parallel Subagent Load Test

- [ ] RED: Add a host-level test where multiple background/subagent model calls target the same local LM Studio resource.
- [ ] GREEN: Ensure background/subagent work queues behind foreground work and drains without starvation.
- [ ] RED: Add tests for cancelling a parent run while subagent local-model requests are queued or active.
- [ ] GREEN: Release queued and active reservations correctly across parent/subagent cancellation paths.
- [ ] REFACTOR: Document local-model capacity guidance for future subagent/team plans.

#### Gate 5

- [ ] Unit, integration, web, and hermetic e2e tests pass.
- [ ] Two Trevor projects cannot overload the same LM Studio resource by default.
- [ ] Parallel subagents queue predictably behind foreground local-model work.
- [ ] Admission state is visible, cancellable, and inspectable.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.
