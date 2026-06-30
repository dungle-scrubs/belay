# Local Model Residency - Implementation Plan

## 0. Hard Dependencies

- [ ] `.plans/11-local-admission-control` provides the substrate eviction rides: the shared owner/lease store with TTL + stale-owner reaping (11 M3), the `local-provider-lifecycle:{providerId}:{normalizedBaseUrl}` lease around load/unload (11 M5), and the generation owner registry (11 M6). Cross-instance-safe eviction is not possible without it. <!-- D-006 -->
- [x] V2 LM Studio provider/client exist: `apps/agent-host/src/providers/lmstudio.ts`, `lmstudio-client.ts`. `ensureMaxContext()` runs `lms unload`/`lms load` today, but only on the SAME model id (to resize) and dedupes only within one client instance.
- [x] Default-provider pre-warm on leader transition: `apps/agent-host/src/main.ts` (~1004-1013) warms `providers[DEFAULT_PROVIDER]` (the 8-bit `qwen` slot).
- [x] Provider registry asymmetry: `apps/agent-host/src/providers/index.ts:59-71` caps `qwen4bit` at `maxContext: 65536` but leaves the 8-bit `qwen` slot uncapped (loads at native 256k).
- [x] `.plans/03-filesystem-root-taxonomy` defines `TREVOR_HOME`, where plan 11's shared residency/lease store lives.
- [x] Completed mid-turn model switch work records a `model.switched` event, an eviction trigger for the mid-turn case (the broader trigger is any change to this instance's active local model).

## 1. Architecture

LM Studio keeps every loaded model resident by default. Trevor loads a local model on demand (`ensureMaxContext` → `lms load`) and pre-warms its default slot, but it only ever unloads the SAME model to resize it - it never evicts a different one. So models accumulate: every local model any instance has touched since LM Studio started stays loaded (3 large models observed co-resident), causing unified-memory/GPU contention that contributed to a stalled local turn. This plan makes Trevor bound its own resident footprint without ever pulling a model another instance is using. <!-- D-001 -->

The bounding is **reference-counted residency across instances**, built on plan 11's shared owner store. Each Trevor instance registers a residency *claim* on the local model it currently wants resident (its active local model). A Trevor-loaded model stays resident while ANY live instance claims it; the actual `lms unload` fires only when the LAST claim is released, while holding plan 11's lifecycle lease, and only when no active generation lease references that model. <!-- D-002 --> A naive per-instance "I switched, unload my previous model" would unload a model another instance is mid-generation on - the exact stall we are fixing - which is why eviction must consult the shared store, not just local state.

Per-instance policy is **keep-only-current (cap 1)**: when an instance's active local model changes, it releases its claim on the previous model and claims the new one. This is a per-instance cap, not a global one - two instances using two different models both keep their models resident (no thrash); what gets reclaimed is only models no live instance claims anymore. <!-- D-003 --> Eviction never targets a model Trevor did not load: only models Trevor itself loaded are eviction-eligible, so a manually-loaded or another-app model (e.g. `qwen3-vl-8b`) is never unloaded. <!-- D-004 --> Crashed-instance claims expire through plan 11's lease TTL + heartbeat, so a dead instance never pins a model forever. <!-- D-007 -->

Separately and with no dependency on plan 11, this plan corrects the per-model context-cap asymmetry: the 8-bit `qwen` slot is capped consistently (as `qwen4bit` already is) instead of loading at native 256k - the heaviest KV-cache configuration and a direct contributor to the slow/stalled turn. <!-- D-005 -->

### Key Constraints

| Constraint | Impact |
|---|---|
| LM Studio direct only | Eviction uses `lms unload` over the existing local endpoint; no emberlm or other control plane. |
| Cross-instance-safe | Eviction consults plan 11's shared store; it never unloads a model another live instance claims or is generating on. |
| Trevor-loaded only | Only models Trevor itself loaded are eviction-eligible; externally-loaded models are never touched. |
| Reference-counted, not global cap | Residency is keep-while-any-live-claim; the per-instance default is cap 1, never a global cap that would thrash. |
| Lease-serialized | Every load/unload (including the new evict call site) acquires plan 11's `local-provider-lifecycle` resource. |
| Context cap independent | The 8-bit slot context cap is pure provider config and ships without depending on plan 11. |
| Inspectable | Resident models, caps, claim counts, and last eviction are visible in `/doctor`. |

### Boundaries

- A new host-owned **local residency** component owns: the set of models THIS instance loaded, the active-model claim lifecycle (claim/release), and the eviction sweep. It is separate from `LmStudioClient` internals.
- `apps/agent-host/src/providers/lmstudio-client.ts` records loads/unloads into the residency component and exposes resident/cap state via `debugInfo()`.
- `apps/agent-host/src/providers/index.ts` owns the per-slot context cap (the 8-bit slot gains a consistent cap).
- Plan 11's shared store owns the cross-process claims, lifecycle lease, generation owner registry, TTL, and stale-reap; this plan is a CONSUMER of that store, not a second coordination mechanism.
- `apps/agent-host` turn/provider resolution owns the eviction trigger: reconcile residency claims when this instance's active local model changes (including the mid-turn `model.switched` case).
- `/doctor` (plan 41 Providers/Models area) owns presentation of residency state.

### Observability

Residency changes runtime load behavior, so observability is first-class:

- events for `residency.claimed`, `residency.released`, `eviction.skipped` (with reason: other-claim / active-generation / not-trevor-loaded), and `eviction.unloaded`;
- fields include model id, endpoint, this instance's id, live claim count, whether a generation lease was active, and the resident set after the change;
- `/doctor` shows resident Trevor-loaded models, their per-model context caps, live claim counts across instances, and the last eviction; <!-- D-008 -->
- the existing `LmStudioClient.debugInfo()` (served context, cap, reloading, lastError) is extended with resident-set + claim state.

## 2. Current State

`ensureMaxContext()` (`lmstudio-client.ts:128-208`) reloads only the SAME model and dedupes only within one `LmStudioClient` instance; there is no host-level registry of which models Trevor loaded and no eviction of a different model. The 8-bit `qwen` slot has no `maxContext`, so it loads at native 256k; `qwen4bit` caps at 65536. Plan 11 (the dependency) is essentially unbuilt (M1, real progress ~0), so this plan is ordered after it.

## 3. Phases

### Phase 1: Per-Model Context Cap (no plan 11 dependency)

**Goal:** The 8-bit local slot loads at a bounded, consistent context instead of native 256k.

**Gate from previous:** Hard dependencies present (this phase needs only the LM Studio provider, not plan 11).

#### M1: Consistent Per-Slot Context Cap

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a test asserting the 8-bit `qwen` slot loads at a capped context (not native 256k), and that the cap is consistent with the 4-bit slot's policy.
  2. GREEN: Add a `maxContext` to the 8-bit slot in `index.ts` and make the per-slot cap policy explicit. <!-- D-005 -->
  3. RED: Add a test that the cap remains overridable (`LMSTUDIO_MAX_CONTEXT` / per-slot `maxContext`).
  4. GREEN: Preserve override precedence over the default cap.
  5. REFACTOR: Unify the per-slot cap policy so 8-bit and 4-bit are not asymmetric by accident; document why the cap exists (KV-cache footprint).

### Gate 1-2

- [ ] The 8-bit local slot no longer loads at native 256k by default.
- [ ] The cap policy is consistent across local slots and overridable.

### Phase 2: Trevor-Loaded Tracking and Residency Claims

**Goal:** Trevor knows which models it loaded, and each instance registers a residency claim in plan 11's shared store.

**Gate from previous:** Context cap shipped; plan 11's shared store (11 M3) is available.

#### M2: Track Trevor-Loaded Models

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add a test that loading a model via `ensureMaxContext` records it in a host-level Trevor-loaded set, and that a model Trevor did not load is absent.
  2. GREEN: Maintain a host-owned residency registry of Trevor-loaded local models (id + endpoint + loaded context). <!-- D-004 -->
  3. RED: Add a test that the set updates on load and on unload.
  4. GREEN: Wire load/unload into the registry.
  5. REFACTOR: Keep the registry a separate host-owned component, not `LmStudioClient` internal state.

#### M3: Residency Claims in Plan 11's Shared Store

- **Dependencies:** M2, plan 11 (M3 shared store)
- **Effort:** M
- **Tasks:**
  1. RED: Add an integration test where two instances each claim their active local model and both claims are visible in an isolated shared store.
  2. GREEN: Register/refresh a residency claim (keyed by the lifecycle resource + model) for this instance's active local model, heartbeating through plan 11's lease. <!-- D-002 -->
  3. RED: Add a test that a crashed instance's claim expires via plan 11's TTL.
  4. GREEN: Rely on plan 11's stale-owner reaping for claim expiry. <!-- D-007 -->
  5. REFACTOR: Reuse plan 11's owner metadata/heartbeat rather than a parallel liveness mechanism.

### Gate 2-3

- [ ] Trevor tracks exactly the models it loaded; external models are excluded.
- [ ] Each instance's active-model claim is visible cross-process and heartbeated.
- [ ] Crashed-instance claims expire via plan 11's TTL.

### Phase 3: Reference-Counted Eviction

**Goal:** A Trevor-loaded model is unloaded only when its last claim is released, safely, under the lifecycle lease.

**Gate from previous:** Claims are tracked cross-process; plan 11's lifecycle lease (M5) and generation registry (M6) are available.

#### M4: Evict-on-Last-Release Under the Lifecycle Lease

- **Dependencies:** M3, plan 11 (M5 lifecycle lease, M6 generation registry)
- **Effort:** L
- **Tasks:**
  1. RED: Add a test where an instance switches its active local model, releases the prior claim, and the model is unloaded ONLY if no other live claim and no active generation lease reference it. <!-- D-002 -->
  2. GREEN: Implement the eviction sweep - acquire the `local-provider-lifecycle` resource, then unload a Trevor-loaded model whose live claim count is zero and which has no active generation lease.
  3. RED: Add a cross-instance test: instance A mid-generation on model X; instance B switching away from X must NOT unload X.
  4. GREEN: Gate eviction on no-active-generation (11 M6) AND Trevor-loaded (M2), serialized by the lifecycle lease.
  5. REFACTOR: Keep the sweep idempotent and lease-serialized so concurrent sweeps cannot double-unload or race a load.

#### M5: Per-Instance Keep-Current Policy (cap 1)

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add a test that, by default, an instance claims only its current active local model (cap 1) and releases the prior one on switch.
  2. GREEN: Implement keep-only-current claim reconciliation on active-local-model change, wired to the eviction trigger (turn provider resolution + mid-turn `model.switched`). <!-- D-003 -->
  3. RED: Add a test that a model still claimed by another live instance survives this instance's switch (no global cap-1 thrash).
  4. GREEN: Ensure release decrements the shared claim count and only the last release triggers a sweep.
  5. REFACTOR: Isolate the policy behind a small seam so an LRU/keep-N variant could replace cap-1 later without touching the eviction core.

### Gate 3-4

- [ ] Switching an instance's active local model evicts the prior model only when it becomes orphaned.
- [ ] Eviction never unloads a model under an active generation lease or one Trevor did not load.
- [ ] Two instances on two different models both stay resident; no evict/reload thrash.

### Phase 4: Visibility and Multi-Instance Verification

**Goal:** Residency and eviction are inspectable and proven across instances.

**Gate from previous:** Eviction is reference-counted and lease-safe.

#### M6: Doctor Residency Surface

- **Dependencies:** M5, plan 41 (Providers/Models area)
- **Effort:** M
- **Tasks:**
  1. RED: Add `/doctor` tests for resident Trevor-loaded models, per-model context caps, live claim counts, and last eviction in the Providers/Models area.
  2. GREEN: Extend `LmStudioClient.debugInfo()` and the doctor snapshot with residency state. <!-- D-008 -->
  3. RED: Add a redaction test proving residency facts expose no secrets.
  4. GREEN: Keep residency facts bounded and sanitized.
  5. REFACTOR: Reuse plan 41's Providers/Models area rather than a new surface.

#### M7: Hermetic Multi-Instance E2E

- **Dependencies:** M6
- **Effort:** L
- **Tasks:**
  1. RED: Add a hermetic e2e with two instances against an isolated fake LM Studio: two models → both resident, no thrash.
  2. GREEN: Prove a model is evicted only after its last claim is released.
  3. RED: Add a case proving a non-Trevor-loaded model is never unloaded, and a model under active generation is never evicted.
  4. GREEN: Implement robust cleanup across instance boundaries.
  5. REFACTOR: Keep the fake-LM-Studio residency fixture reusable for future local-provider tests.

### Done Gate

- [ ] Unit, integration, and hermetic e2e tests pass for residency + eviction.
- [ ] The 8-bit local slot is context-capped consistently.
- [ ] Eviction is reference-counted, lease-safe, and never touches externally-loaded or in-generation models.
- [ ] Two instances on two models stay resident; orphaned models are reclaimed.
- [ ] `/doctor` shows resident models, caps, claim counts, and last eviction.

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---|---|---|---|
| Eviction unloads a model another instance is using | high | medium | Reference-counted claims + active-generation gate + lifecycle lease; cross-instance e2e proves safety. | agent-host |
| Plan 11 unbuilt, blocking this plan | high | high | Phase 1 (context cap) ships with no plan 11 dependency; eviction phases are explicitly gated on plan 11 milestones. | agent-host |
| Global cap-1 thrash between instances | high | low | Per-instance keep-current, not a global cap; two-instance-two-model test asserts no thrash. | agent-host |
| Stale claim pins a model forever | medium | medium | Reuse plan 11's lease TTL + heartbeat for claim expiry. | agent-host |
| Trevor evicts an externally-loaded model | high | low | Only Trevor-loaded models are eviction-eligible; e2e asserts external models are never unloaded. | agent-host |

## 5. Escape Hatches

1. **If plan 11's shared store slips:** ship Phase 1 (context cap) alone for immediate KV-cache relief, and keep the residency phases queued behind plan 11.
2. **If reference-counted eviction is too costly for the first cut:** keep claims + the active-generation gate but evict only at host shutdown / explicit `/doctor` action, deferring automatic evict-on-switch.
3. **If cap-1 proves too aggressive:** the M5 policy seam allows a keep-N / LRU variant without changing the eviction core.

## 6. Validation Commands

```bash
pnpm --filter @trevor/agent-host test -- --run
pnpm test -- --project integration
pnpm test -- --project e2e
```

## 7. Decisions

Canonical decisions are in the plan database (`.plans/11.1-local-model-residency/plan.db`). Query with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "11.1-local-model-residency"
```
