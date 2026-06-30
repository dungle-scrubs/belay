# Local Model Residency - Progress Report

## Summary

- **Current cutoff blockers:** 41
- **Completed current work:** 5
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M2 - Track Trevor-Loaded Models
- **Note:** Phases 2-4 are gated on `.plans/11-local-admission-control` (shared store, lifecycle lease, generation registry); Phase 1 (context cap) has no plan 11 dependency. See implementation.md §0 for the full hard-dependency list.

## Completed Current State / Hard Dependencies

- [x] V2 LM Studio provider/client exist (`lmstudio.ts`, `lmstudio-client.ts`); `ensureMaxContext()` unloads only the same model and dedupes only within one client instance.
- [x] Default-provider pre-warm on leader transition (`main.ts` ~1004-1013) warms the 8-bit `qwen` slot.
- [x] Provider registry asymmetry (`index.ts:59-71`): `qwen4bit` capped at 65536, 8-bit `qwen` slot uncapped (native 256k).
- [x] `.plans/03-filesystem-root-taxonomy` defines `TREVOR_HOME`, where plan 11's shared store lives.
- [x] Completed mid-turn model switch records `model.switched`, an eviction trigger for the mid-turn case.

## Current Cutoff Blockers

### Phase 1: Per-Model Context Cap (no plan 11 dependency)

#### M1: Consistent Per-Slot Context Cap

- [x] RED: Add a test asserting the 8-bit `qwen` slot loads at a capped context (not native 256k), and that the cap is consistent with the 4-bit slot's policy.
- [x] GREEN: Add a `maxContext` to the 8-bit slot in `index.ts` and make the per-slot cap policy explicit.
- [x] RED: Add a test that the cap remains overridable (`LMSTUDIO_MAX_CONTEXT` / per-slot `maxContext`).
- [x] GREEN: Preserve override precedence over the default cap.
- [x] REFACTOR: Unify the per-slot cap policy so 8-bit and 4-bit are not asymmetric by accident; document why the cap exists (KV-cache footprint).

#### Gate 1-2

- [x] The 8-bit local slot no longer loads at native 256k by default.
- [x] The cap policy is consistent across local slots and overridable.

### Phase 2: Trevor-Loaded Tracking and Residency Claims

#### M2: Track Trevor-Loaded Models

- [ ] RED: Add a test that loading a model via `ensureMaxContext` records it in a host-level Trevor-loaded set, and that a model Trevor did not load is absent.
- [ ] GREEN: Maintain a host-owned residency registry of Trevor-loaded local models (id + endpoint + loaded context).
- [ ] RED: Add a test that the set updates on load and on unload.
- [ ] GREEN: Wire load/unload into the registry.
- [ ] REFACTOR: Keep the registry a separate host-owned component, not `LmStudioClient` internal state.

#### M3: Residency Claims in Plan 11's Shared Store

- [ ] RED: Add an integration test where two instances each claim their active local model and both claims are visible in an isolated shared store.
- [ ] GREEN: Register/refresh a residency claim (keyed by the lifecycle resource + model) for this instance's active local model, heartbeating through plan 11's lease.
- [ ] RED: Add a test that a crashed instance's claim expires via plan 11's TTL.
- [ ] GREEN: Rely on plan 11's stale-owner reaping for claim expiry.
- [ ] REFACTOR: Reuse plan 11's owner metadata/heartbeat rather than a parallel liveness mechanism.

#### Gate 2-3

- [ ] Trevor tracks exactly the models it loaded; external models are excluded.
- [ ] Each instance's active-model claim is visible cross-process and heartbeated.
- [ ] Crashed-instance claims expire via plan 11's TTL.

### Phase 3: Reference-Counted Eviction

#### M4: Evict-on-Last-Release Under the Lifecycle Lease

- [ ] RED: Add a test where an instance switches its active local model, releases the prior claim, and the model is unloaded ONLY if no other live claim and no active generation lease reference it.
- [ ] GREEN: Implement the eviction sweep - acquire the `local-provider-lifecycle` resource, then unload a Trevor-loaded model whose live claim count is zero and which has no active generation lease.
- [ ] RED: Add a cross-instance test: instance A mid-generation on model X; instance B switching away from X must NOT unload X.
- [ ] GREEN: Gate eviction on no-active-generation (11 M6) AND Trevor-loaded (M2), serialized by the lifecycle lease.
- [ ] REFACTOR: Keep the sweep idempotent and lease-serialized so concurrent sweeps cannot double-unload or race a load.

#### M5: Per-Instance Keep-Current Policy (cap 1)

- [ ] RED: Add a test that, by default, an instance claims only its current active local model (cap 1) and releases the prior one on switch.
- [ ] GREEN: Implement keep-only-current claim reconciliation on active-local-model change, wired to the eviction trigger (turn provider resolution + mid-turn `model.switched`).
- [ ] RED: Add a test that a model still claimed by another live instance survives this instance's switch (no global cap-1 thrash).
- [ ] GREEN: Ensure release decrements the shared claim count and only the last release triggers a sweep.
- [ ] REFACTOR: Isolate the policy behind a small seam so an LRU/keep-N variant could replace cap-1 later without touching the eviction core.

#### Gate 3-4

- [ ] Switching an instance's active local model evicts the prior model only when it becomes orphaned.
- [ ] Eviction never unloads a model under an active generation lease or one Trevor did not load.
- [ ] Two instances on two different models both stay resident; no evict/reload thrash.

### Phase 4: Visibility and Multi-Instance Verification

#### M6: Doctor Residency Surface

- [ ] RED: Add `/doctor` tests for resident Trevor-loaded models, per-model context caps, live claim counts, and last eviction in the Providers/Models area.
- [ ] GREEN: Extend `LmStudioClient.debugInfo()` and the doctor snapshot with residency state.
- [ ] RED: Add a redaction test proving residency facts expose no secrets.
- [ ] GREEN: Keep residency facts bounded and sanitized.
- [ ] REFACTOR: Reuse plan 41's Providers/Models area rather than a new surface.

#### M7: Hermetic Multi-Instance E2E

- [ ] RED: Add a hermetic e2e with two instances against an isolated fake LM Studio: two models → both resident, no thrash.
- [ ] GREEN: Prove a model is evicted only after its last claim is released.
- [ ] RED: Add a case proving a non-Trevor-loaded model is never unloaded, and a model under active generation is never evicted.
- [ ] GREEN: Implement robust cleanup across instance boundaries.
- [ ] REFACTOR: Keep the fake-LM-Studio residency fixture reusable for future local-provider tests.

#### Done Gate

- [ ] Unit, integration, and hermetic e2e tests pass for residency + eviction.
- [ ] The 8-bit local slot is context-capped consistently.
- [ ] Eviction is reference-counted, lease-safe, and never touches externally-loaded or in-generation models.
- [ ] Two instances on two models stay resident; orphaned models are reclaimed.
- [ ] `/doctor` shows resident models, caps, claim counts, and last eviction.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.
