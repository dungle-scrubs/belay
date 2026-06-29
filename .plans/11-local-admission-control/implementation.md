# Local Admission Control - Implementation Plan

## 0. Hard Dependencies

- [x] V2 LM Studio provider/client exists in `apps/agent-host/src/providers/lmstudio.ts` and `apps/agent-host/src/providers/lmstudio-client.ts`.
- [x] V2 LM Studio context warming currently dedupes only inside one provider instance through `LmStudioClient.ensureMaxContext()`.
- [x] V1 local admission provenance found in `/Users/kevin/dev/trevor/packages/agent-host/src/provider/local-admission.ts`.
- [x] V1 local admission tests found in `/Users/kevin/dev/trevor/packages/agent-host/test/provider/local-pi-ai-provider.test.ts`.
- [x] `03-filesystem-root-taxonomy` defines `TREVOR_HOME` for durable Trevor state, ownership records, and locks.
- [x] Parallel subagents and multi-project LM Studio usage make this a prerequisite for local-provider stability.

## 1. Architecture

Local admission control is the machine-level coordination layer for Trevor-owned local model usage. It protects LM Studio and other local runtimes from accidental overload, model reload races, and hidden cross-project contention when multiple Trevor projects, sessions, or subagents try to stream through the same local model endpoint at the same time. <!-- D-001 -->

V1 already proved the in-process shape: key local requests by concrete provider/base URL/model, estimate prompt plus max-output tokens, reserve capacity before dispatch, queue when concurrency is full, refuse impossible requests before provider dispatch, and emit reserved/queued/released/refused events. V2 should keep those lessons, but the boundary must move from a process-local `Map` to a cross-process admission service or lease store because the user will increasingly run multiple projects and parallel subagents against the same LM Studio runtime. <!-- D-002 -->

The default policy for LM Studio is conservative: one active generation per local runtime/model resource, with explicit configuration needed to raise concurrency. This keeps parallel subagents useful without letting parallel model calls silently degrade each other or trigger competing `lms load`/`unload` operations. <!-- D-003 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| LM Studio direct only | This project keeps talking to LM Studio through pi-ai and LM Studio's API/CLI; no emberlm dependency is introduced. |
| Machine-level coordination | Admission must work across multiple Trevor projects and host processes, not only inside one agent-host instance. |
| Local providers only | Cloud providers are not throttled by this plan. |
| Conservative default | LM Studio defaults to one active generation for a resource unless config says otherwise. |
| Lifecycle-safe | Model load/reload operations cannot race active generations or other reloads. |
| Visible waiting | Queued local-model work must show a clear waiting state, queue position when known, and cancellation behavior. |
| Cancellation-safe | Cancelling a turn or subagent releases queued or active admission state promptly. |
| No durable transcript pollution | Admission waits are live status/tool state, not permanent assistant content unless they become a meaningful failure. |

### Resource Model

Admission uses explicit resource keys derived from the concrete local provider target:

```text
local-provider:{providerId}:{normalizedBaseUrl}:{modelId}
```

LM Studio also needs a lifecycle resource for load/reload operations:

```text
local-provider-lifecycle:{providerId}:{normalizedBaseUrl}
```

The lifecycle resource serializes `ensureMaxContext()` and any future model load/unload operation for an endpoint. The generation resource controls active streams. The first implementation should default both to capacity `1` for LM Studio. A later provider may expose higher concurrency metadata, but that must be explicit and test-backed.

### Queue Policy

Admission requests carry:

- resource key and lifecycle key;
- priority class: foreground user turn, recovery/retry/continuation, interactive command-backed model work, background subagent, maintenance/warm;
- owner metadata: project root, cwd, session id, run id, agent/subagent id, pid, provider, model, started time, heartbeat time;
- cancellation signal;
- estimated prompt tokens, max output tokens, and context window when known.

Priority order is foreground user work first, then recovery/continuation, then interactive command-backed work, then background/subagent work, then maintenance/warm work. FIFO applies inside the same priority. <!-- D-004 -->

### Storage and Coordination

Durable coordination state belongs under `TREVOR_HOME` because it is product state and lock/ownership data, not debug output. Diagnostic history, admission traces, and aggregate metrics belong under `${XDG_STATE_HOME:-~/.local/state}/trevorV2`. <!-- D-005 -->

The implementation may be either:

1. a lightweight file/SQLite-backed lease store under `TREVOR_HOME`, used directly by each host process; or
2. a local admission daemon/service if direct file coordination becomes fragile.

The first cut should prefer the smallest robust implementation that supports atomic acquire, heartbeat, release, stale owner reap, priority ordering, and debug inspection. It must not invent a new dot-directory.

### Boundaries

- `apps/agent-host/src/providers` owns provider integration points: LM Studio lifecycle admission around `ensureMaxContext()` and stream admission around local model dispatch.
- A new local admission module owns resource keying, leases, queueing, priority, stale owner reaping, config, and debug snapshots.
- `apps/agent-host` turn/subagent orchestration owns priority assignment, cancellation wiring, and user-visible waiting state.
- `packages/session` owns any protocol events/read-model fields needed for local-admission status.
- `apps/web` owns status presentation in the transcript/task surfaces and compact rows.
- `/doctor` owns debug inspection of current local-model owners, queue depth, stale locks, and recent admission failures.

### Observability

Admission changes provider/runtime behavior, so observability is first-class:

- spans/events for `local_admission.acquire_requested`, `queued`, `acquired`, `released`, `refused`, `stale_reaped`, `heartbeat_failed`, and `lifecycle_wait`;
- fields include resource key hash, provider, model, base URL host/port, priority, owner ids, queue position, wait duration, active duration, estimated tokens, context window, release reason, and refusal class;
- `/doctor` shows active owners, queue length, oldest wait, stale locks, last refusal, and lifecycle lock state;
- transcript/status rows show "waiting for LM Studio" or equivalent action-specific shimmer while queued;
- diagnostic JSONL may be written best-effort under Trevor state for later analysis, but admission must continue if diagnostics fail.

## 2. Current State

V2 currently has an LM Studio provider that streams through pi-ai and a client that probes `/api/v0/models/:model`, learns context/tool/vision capability, and best-effort reloads the model at max context with `lms unload` / `lms load`. `ensureMaxContext()` dedupes concurrent calls only inside one `LmStudioClient` instance. It does not coordinate with another Trevor project, another host process, or future parallel subagents.

V1 has a useful process-local admission module. It admits only local provider identities, keys by concrete provider/base URL/model, defaults `maxParallel` to `1`, honors provider concurrency metadata when present, estimates active token reservations, refuses impossible requests, queues over-capacity requests, releases reservations after success/failure, and emits provider interaction events. That is strong provenance, but it does not solve cross-process LM Studio contention.

## 3. Phases

### Phase 1: Contract and Provenance

**Goal:** Define the V2 admission contract from V1 behavior plus the new cross-process LM Studio requirement.

**Gate from previous:** H-057 has been extracted from the umbrella plan.

#### M1: V1 Provenance Snapshot

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add provenance tests or fixtures capturing V1 local admission reserved, queued, refused, released, active-budget refusal, alias collapse, and provider concurrency metadata behaviors.
  2. GREEN: Document the V1 target-key, estimate, queue, release, and interaction-event contract as intended V2 behavior.
  3. RED: Add V2 contract tests for provider/base URL/model keying and local-only admission.
  4. GREEN: Define V2 local-admission types, resource keys, release reasons, refusal classes, and debug snapshots.
  5. REFACTOR: Keep V1 provenance separate from V2's cross-process implementation boundary.

#### M2: Cross-Process Admission Contract

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add contract tests for two independent host/admission clients contending for the same LM Studio resource.
  2. GREEN: Define acquire, heartbeat, release, cancel, stale-reap, and snapshot operations.
  3. RED: Add tests for priority ordering: foreground before recovery before command-backed before background/subagent before maintenance.
  4. GREEN: Define priority assignment rules and FIFO ordering inside equal priority.
  5. REFACTOR: Keep local admission independent from turn scheduling so it can protect subagents and future local-provider call sites.

### Gate 1->2

- [ ] V1 admission lessons are captured as provenance.
- [ ] V2 has an explicit cross-process acquire/queue/release contract.
- [ ] Priority classes and resource keys are specified.

### Phase 2: Shared Lease and Queue Store

**Goal:** Multiple Trevor host processes coordinate local model access through a shared durable admission store.

**Gate from previous:** Admission contract is explicit.

#### M3: Shared Store and Atomic Leases

- **Dependencies:** M2, `03-filesystem-root-taxonomy`
- **Effort:** L
- **Tasks:**
  1. RED: Add integration tests using an isolated `TREVOR_HOME` where two admission clients cannot both acquire a capacity-1 resource.
  2. GREEN: Implement shared store acquire/release with atomicity, owner metadata, capacity, and resource snapshots.
  3. RED: Add tests for process crash/stale owner TTL and heartbeat refresh.
  4. GREEN: Implement heartbeat and stale owner reaping without stealing a healthy active owner.
  5. REFACTOR: Keep diagnostic writes best-effort and separate from durable coordination state.

#### M4: Queue, Priority, and Cancellation

- **Dependencies:** M3
- **Effort:** L
- **Tasks:**
  1. RED: Add tests for queued acquire, queue position, FIFO within priority, and priority ordering across foreground/background work.
  2. GREEN: Implement queue records and wake/drain behavior after release or stale reap.
  3. RED: Add tests proving cancellation removes queued requests and releases active requests.
  4. GREEN: Wire cancellation signals through queued and active reservations.
  5. REFACTOR: Normalize failure modes for timeout, cancelled, stale-reaped, refused, and store-unavailable cases.

### Gate 2->3

- [ ] Cross-process capacity is enforced under an isolated `TREVOR_HOME`.
- [ ] Queued requests wake deterministically in priority order.
- [ ] Cancellation never leaves active or queued admission records behind.

### Phase 3: LM Studio Provider Integration

**Goal:** LM Studio lifecycle and streaming calls are protected by local admission without changing cloud-provider behavior.

**Gate from previous:** Shared store and queue semantics are reliable.

#### M5: Lifecycle Admission Around `ensureMaxContext`

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for two host processes attempting LM Studio context reload at the same time.
  2. GREEN: Acquire the endpoint lifecycle resource before `lms unload` / `lms load` work.
  3. RED: Add tests proving active generation prevents unsafe reload or makes reload wait behind active work.
  4. GREEN: Coordinate lifecycle and generation resources so reloads do not race active streams.
  5. REFACTOR: Surface lifecycle wait/reload state in `LmStudioClient.debugInfo()`.

#### M6: Generation Admission Around Local Streams

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Add provider tests proving two local streams for the same LM Studio resource serialize by default.
  2. GREEN: Acquire generation admission before local pi-ai stream dispatch and release on success, failure, or cancellation.
  3. RED: Add tests proving cloud providers and non-local providers bypass local admission.
  4. GREEN: Scope admission to `kind: "local"` providers and concrete local target metadata.
  5. REFACTOR: Preserve existing provider failure taxonomy and overflow behavior.

### Gate 3->4

- [ ] LM Studio load/reload operations are serialized safely.
- [ ] LM Studio generation streams obey configured resource capacity.
- [ ] Cloud providers are unaffected.

### Phase 4: User-Visible Waiting and Debuggability

**Goal:** Waiting for local model capacity is clear, cancellable, and inspectable.

**Gate from previous:** Provider integration emits admission state.

#### M7: Transcript/Task Status

- **Dependencies:** M6, `09-task-panel-freshness`
- **Effort:** M
- **Tasks:**
  1. RED: Add protocol/read-model tests for queued, acquired, released, refused, and cancelled admission events.
  2. GREEN: Emit bounded live status for "waiting for LM Studio", queue position, provider/model, and priority class.
  3. RED: Add web/Storybook fixtures for foreground waiting, background subagent waiting, refused, and cancelled states.
  4. GREEN: Render visible waiting state through existing task/transcript status patterns without permanent transcript noise.
  5. REFACTOR: Reuse action shimmer/status primitives where available.

#### M8: Doctor, Config, and Metrics

- **Dependencies:** M6
- **Effort:** M
- **Tasks:**
  1. RED: Add `/doctor` tests for active local owners, queue length, oldest wait, lifecycle lock, stale lock, and last refusal.
  2. GREEN: Add doctor/debug snapshots for local admission.
  3. RED: Add config tests for default LM Studio capacity 1 and explicit per-resource capacity overrides.
  4. GREEN: Add preference/config parsing for local admission concurrency and TTL settings.
  5. REFACTOR: Emit best-effort admission diagnostics under Trevor state without affecting turns when diagnostic writes fail.

### Gate 4->5

- [ ] Users can see why a local model turn or subagent is waiting.
- [ ] Cancelling queued local work removes it from the queue.
- [ ] `/doctor` explains local model ownership and queue state.

### Phase 5: E2E and Parallel Subagent Readiness

**Goal:** Admission is proven under multi-process and parallel-subagent scenarios.

**Gate from previous:** Waiting/debug surfaces exist.

#### M9: Hermetic Multi-Process E2E

- **Dependencies:** M8
- **Effort:** L
- **Tasks:**
  1. RED: Add hermetic e2e with two host processes/projects sharing an isolated fake LM Studio resource.
  2. GREEN: Prove one process acquires while the other queues, then drains after release.
  3. RED: Add crash/stale-lock e2e where the active owner disappears and the queued owner proceeds only after TTL.
  4. GREEN: Implement robust cleanup and stale owner handling across process boundaries.
  5. REFACTOR: Keep the e2e fake local provider reusable for future subagent tests.

#### M10: Parallel Subagent Load Test

- **Dependencies:** M9
- **Effort:** M
- **Tasks:**
  1. RED: Add a host-level test where multiple background/subagent model calls target the same local LM Studio resource.
  2. GREEN: Ensure background/subagent work queues behind foreground work and drains without starvation.
  3. RED: Add tests for cancelling a parent run while subagent local-model requests are queued or active.
  4. GREEN: Release queued and active reservations correctly across parent/subagent cancellation paths.
  5. REFACTOR: Document local-model capacity guidance for future subagent/team plans.

### Gate 5

- [ ] Unit, integration, web, and hermetic e2e tests pass.
- [ ] Two Trevor projects cannot overload the same LM Studio resource by default.
- [ ] Parallel subagents queue predictably behind foreground local-model work.
- [ ] Admission state is visible, cancellable, and inspectable.

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| File/SQLite locking behaves differently across platforms | high | medium | Use isolated integration/e2e tests and keep an escape hatch for a small local daemon if direct coordination is fragile. | agent-host |
| Stale owner reap steals a slow healthy model turn | high | medium | Heartbeat active owners, use conservative TTLs, and include pid/process liveness where available. | agent-host |
| Queueing hides why subagents are slow | medium | high | Make waiting state visible in task/transcript surfaces and `/doctor`. | web/agent-host |
| LM Studio supports more concurrency than the default | low | medium | Default to one; allow explicit per-resource capacity only when the user opts in. | agent-host |
| Lifecycle reload waits can deadlock generation leases | high | medium | Model lifecycle and generation lock ordering explicitly; test active generation plus reload contention. | agent-host |

## 5. Escape Hatches

1. **If direct file/SQLite coordination is unreliable:** introduce a small Trevor-owned local admission daemon under the existing host/service model, while keeping the same acquire/queue/release contract.
2. **If queue priority becomes too complex for the first cut:** ship FIFO per resource with foreground/background visibility, but keep the priority fields in the contract so ordering can be enabled without protocol churn.
3. **If LM Studio lifecycle locking blocks useful parallelism:** keep lifecycle locks endpoint-global, but allow generation locks to become per-model only after tests prove LM Studio handles that safely.

## 6. Validation Commands

```bash
pnpm --filter @trevor/agent-host test -- --run
pnpm test -- --project integration
pnpm test -- --project web
pnpm test -- --project e2e
```

## 7. Decisions

Canonical decisions are in the plan database (`.plans/11-local-admission-control/plan.db`). Query with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "11-local-admission-control"
```
