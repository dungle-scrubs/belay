# Deepen — RFC

## Summary

A standing initiative to **deepen shallow modules** across Trevor V2,
applying Ousterhout's deep-modules discipline (high functionality behind a
simple interface). This is not a feature; it is a refactoring backlog derived
from repeated design audits. Each audit round appends a phase of ranked
candidates. The plan is the durable home for "where the abstraction isn't
earning its keep" so the work can be picked up incrementally without
re-auditing.

This RFC seeds the plan with **Round 1 — the host (`apps/agent-host`)**.
Later rounds (web frontend, transport/session/stores) append phases.

## Motivation

The host has grown organically. Several modules expose an interface roughly
as wide as their implementation: callers orchestrate state machines by hand,
near-identical providers duplicate control flow, and each tool re-decides its
own error/validation/output policy. These are not bugs - the code is tested
and correct - but the boundaries leak knowledge, so a change in one place
forces edits in many. Deepening these boundaries shrinks callsites, removes
implicit sequencing hazards, and makes the next feature cheaper to land.

## Non-goals

- **Not** rewriting working logic. Behavior is preserved; only boundaries move.
- **Not** chasing line count. A small module is not a target; a wide interface is.
- **Not** authorized to pull forward dropped/backlog features (see canonical
  plan §4/§7). This plan only re-shapes existing internals.
- **Not** a single big-bang refactor. Each milestone is independently shippable
  behind green tests.

## Approach

Each candidate becomes a milestone. Because every target is already covered by
tests (unit/integration/conformance per `AGENTS.md`), the discipline is:

1. **Characterize** - confirm the current behavior is pinned by tests; add a
   characterization test if a seam is under-covered.
2. **Introduce the deeper boundary** - new interface alongside the old.
3. **Migrate callers** - move callsites onto the new boundary.
4. **Delete the shallow surface** - remove the methods/duplication the boundary
   replaced.
5. **Green** - all existing tests pass unchanged (behavior preserved); refactor.

## Round 1 candidates (the host)

Ranked by `(callers benefiting) × (clarity of boundary) ÷ churn`.

### High

1. **`agent/turn-scheduler.ts` — collapse the state-machine surface.**
   13 fine-grained mutation methods over ~100 lines, all driven from `main.ts`,
   with an implicit, unenforced `recordAnswer → drain → maybeCompact` sequencing
   contract. Consolidate into lifecycle entry points (`processCompletion`,
   `noteTurn`) that hide internal sequencing; keep `cancel`/`clearPending`/
   `resetForReconnect` as recovery entry points.

2. **`providers/{codex,pi-key}.ts` — extract `PiAiProviderBase`.**
   The two providers duplicate `stream`/`readiness`/`capabilities` control flow
   and both re-declare `AUTH_PATH`; only the credential strategy differs (OAuth
   refresh vs static key + model synthesis). Extract a base parameterized by a
   pluggable `CredentialResolver`.

3. **`tools/*` — a deeper tool-definition primitive.**
   `bash.ts` is a thin shim; `glob`/`grep` repeat the same scan/`SKIP_DIRS`/
   accumulate/`cap()` loop; `edit`/`multi-edit` repeat `confine → replace →
   strip-error-prefix → relative-path`; `shared.ts` wraps errors but each tool
   still hand-builds error types and decides its own policy. Introduce a tool
   primitive that owns workspace resolution, validation, error envelope, and
   `cap()`, plus a shared search iterator and a confine-and-replace helper.

### Medium

4. **`providers/pi-ai.ts` — stop being a policy hub.**
   Leaks auth-error classification, overflow constants, and system-prompt
   construction into the shared adapter. Extract a `ProviderErrorClassifier`
   and pass `systemPrompt` in from the turn-runner so pi-ai is a thin adapter.

5. **`providers/lmstudio.ts` — split client from provider.**
   Mixes model-load lifecycle (load/dedup/ring buffer, env-coupled constructor)
   with the `Provider` interface. Split `LmStudioClient` from `LmStudioProvider`;
   move env resolution to an explicit config factory.

6. **`usage/breakdown.ts` — hide the category schema.**
   `snapshot()` returns raw internal category state; callers hand-sum fields by
   iterating `BREAKDOWN_CATEGORIES`. Expose category-driven accessors so new
   categories flow to callers without re-opening them.

7. **`commands.ts` — narrow the context, own `/skills` in `skills.ts`.**
   A wide `CommandContext` is forwarded field-by-field; commands.ts reaches into
   `skills.ts` internals (`SKILLS_DIR`, `discoverSkills`). Move `/skills`
   construction into `skills.ts`; give commands narrow inputs.

8. **`providers/index.ts` — registry builder.**
   `buildProviders()` consults 7 env vars in a hand-coded block; adding a
   provider means editing the block and threading config. Introduce a registry
   builder / per-provider factory so env resolution lives with each provider.

## Risks

- **Behavioral regression while moving boundaries.** Mitigated by the
  characterize-first step and the existing test tiers; behavior must be pinned
  before the boundary moves.
- **Effect Layer wiring churn** (services.ts/index.ts) for the provider work -
  keep the `Provider` interface stable so Layer composition is untouched.
- **Scope creep into rewrites.** Each milestone is bounded to a single boundary;
  "while I'm here" rewrites are out of scope.

## Open questions

- Sequencing: candidates are independent; default order is by rank. No hard
  dependencies between Round 1 milestones.
