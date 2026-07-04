# Route-Aware System Prompt — Progress Report

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks | 19 |
| Completed | 0 |
| Deferred / future-phase | 0 |
| Superseded | 0 |

**Current focus:** Phase 1 M1 — thread `capabilities` + `contextWindow` into `SystemPromptContext`.

**Stage:** RFC → READY (this plan enters the backlog at `ready`; implementation begins on its own branch off `main`).

---

## Phase 1: Thread route data into the builder (the seam)

**Goal:** `SystemPromptContext` carries `capabilities` and `contextWindow`, threaded
from every call site, behavior byte-identical to today.

### M1: Extend SystemPromptContext and thread the call sites

- [ ] RED: Add a unit test asserting `buildSystemPrompt(tools, { contextWindow, capabilities })` produces the full prompt (byte-identical to today) when the window is large/absent. <!-- D-001 -->
- [ ] GREEN: Add optional `capabilities?: ModelCapabilities` and `contextWindow?: number` to `SystemPromptContext` (`system-prompt.ts`).
- [ ] RED: Add a test asserting the `turn.ts` breakdown-seed call passes `contextWindow` when available on the turn provider.
- [ ] GREEN: Thread `contextWindow` (+ `capabilities` where reachable) from the `pi-ai.ts:406` live build and `turn.ts:167` breakdown-seed build into `SystemPromptContext`.
- [ ] REFACTOR: Ensure no call site constructs a `SystemPromptContext` without considering route data (single helper if construction is repeated).

---

## Phase 2: Budget-tier guidance narrowing

**Goal:** Small served windows get a leaner prompt; large windows unchanged. Tier
driven by `contextWindow` (served), not `contextLength` (native). <!-- D-004 -->

### M2: Define the tier policy and the condensed guidance set

- [ ] RED: With `contextWindow` below the small threshold (e.g. 16k), assert the prompt omits detailed LSP/MCP/docs/archive/delegate/tool_script blocks but retains identity, execution context, core coding guidance, and confinement.
- [ ] GREEN: Implement a pure `guidanceTier(contextWindow): "full" | "core" | "minimal"` selector and a tier-aware guidance renderer. Initial tiers: full (>= 64k), core (16k-64k), minimal (< 16k).
- [ ] RED: Assert the medium tier keeps condensed forms (not fully dropped) of high-value blocks — a representative phrase from each retained block present, from each dropped block absent.
- [ ] GREEN: Implement condensed rendering for the core tier.
- [ ] RED: Assert absent/unknown `contextWindow` falls back to the full prompt (never silently narrows on missing data).
- [ ] GREEN: Implement the absent-data fallback to `"full"`.
- [ ] REFACTOR: Consolidate tier thresholds + per-tier block lists into one declared table (policy as one read).

### M3: promptOverheadChars and breakdown consistency

- [ ] RED: Assert `promptOverheadChars` reflects the tier-adapted prompt length (breakdown seed shrinks for small-window turns).
- [ ] GREEN: Ensure the `turn.ts` breakdown-seed call passes route data so `promptOverheadChars` measures the prompt the model will actually receive.
- [ ] REFACTOR: Confirm the single-formula invariant — breakdown seed and provider overflow estimate still share `promptOverheadChars` and cannot disagree.

---

## Phase 3: Verification and edge cases

**Goal:** Correct across large-cloud-unchanged, small-local-leaner, mid-turn
re-tier, and missing-data-safe.

### M4: Mid-turn switch and hermetic verification

- [ ] RED: Integration test (hermetic / `test/turn.test.ts` shape) switching mid-turn from large-window to small-window via `SwitchCell`; assert the post-switch step's prompt is the leaner tier. <!-- D-003 -->
- [ ] GREEN: Confirm the per-step `buildSystemPrompt` picks up the new `contextWindow` after the switch (characterizes the 09.1 composition; should need no new code if M1 is correct).
- [ ] RED: A provider with large `contextLength` but small `contextWindow` gets the small tier (served window wins). <!-- D-004 -->
- [ ] GREEN: Confirm the tier selector reads `contextWindow`, not `contextLength`.
- [ ] REFACTOR: Move the tier table + guidance block map behind the builder's single-read point so call sites stay ignorant of the policy.

---

## Decisions

- **D-001** Thread `capabilities` + `contextWindow` into `SystemPromptContext`; data already exists at the call sites.
- **D-002** Budget-tier narrowing, not model-identity injection.
- **D-003** No new re-read boundary; per-step build + 09.1 SwitchCell already handle mid-turn switches.
- **D-004** Tiers driven by `contextWindow` (served), not `contextLength` (native).

## Notes

- Plan composes with the merged 09.1 (mid-turn switch) for free: because the prompt
  is rebuilt per step and the model is re-read per step, a mid-turn switch to a
  different-window model automatically produces a re-tiered prompt on the next step.
- The existing `promptOverheadChars` single-formula invariant means a leaner prompt
  is reflected in both the breakdown seed and the overflow estimate with no second
  formula to keep in sync.
