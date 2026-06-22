# Trevor V2 Host Rebuild — Spike Guide

> **SUPERSEDED IN PART (2026-06-22 pivot).** A-001 (Effect under `bun --compile`) and A-003 (copied Rust TUI
> builds) are retired - the host is no longer a Bun binary and there is no TUI (D-013, D-018). A-002 (v3
> entry) is recorded as D-001. A-004 (pi-ai interruption) remains live and is validated at Slice 2. Current
> plan: `implementation.md`.

> Four assumptions gate the rebuild. Each is a timeboxed experiment with a measurable pass
> criterion. Run these in the SPIKE stage **before** feature work (A-004 is validated at the
> start of slice S1, since it needs the pi-ai wrap). Record results with
> `plan-db validate-assumption --code A-00N --status pass|fail|deferred --evidence "…"`.

## Assumptions

### A-001: Effect v3 runs under `bun build … --compile` with interruption intact
- **Impact if false:** The compiled-binary distribution model breaks. The TUI's default
  `TREVOR_HOST_CMD` expects a runnable host command; the fallback is interpreted `bun run`
  via the `TREVOR_HOST_CMD` env override (no TUI source change) — but the compiled
  distribution would have to be reconsidered (Escape Hatch 1). D-006 MUST NOT be committed
  until this passes.
- **Experiment:** Write a non-trivial Effect v3 program: fork a fiber that sleeps and holds a
  finalizer, interrupt it from the parent, and assert (a) the finalizer runs and (b) the
  interrupt is observed. Run it three ways: `bun test`, `bun run`, and as a `bun build …
  --compile` binary. Exercise `Effect.race`/`Effect.timeout` + `AsyncLocalStorage`/span
  context, since those lean on microtask ordering that compiled Bun can perturb.
- **Pass criteria:** Identical, correct interruption + finalizer behavior under all three; no
  deadlock, no out-of-order fiber scheduling in the compiled binary.
- **Effort:** S (½–1 day).

### A-002: Effect v3 is viable for the project horizon (v3→v4 entry posture)
- **Impact if false:** Re-evaluate the entry version. Non-gating — does not block Phase 2.
- **Experiment:** Read the Effect v4-beta migration material; assess v3 maturity, the v3→v4
  upgrade path, and whether v3 is near end-of-life. Record a written entry decision with the
  bounded upgrade cost.
- **Pass criteria:** A written posture: enter on v3 now (decided, D-001), with a documented,
  acceptable v3→v4 cost — or a justified change of entry version.
- **Effort:** S (½ day, reading).

### A-003: The copied `trevorV2/tui` compiles unchanged
- **Impact if false:** The "reuse the TUI unchanged" premise is wrong — there is a coupling
  beyond the 11 already-copied embedded artifacts. Must be reconciled (by supplying the
  missing artifact at its path, NOT by editing TUI source) before any host work.
- **Experiment:** `cargo build --manifest-path tui/Cargo.toml` in `trevorV2`. If it fails on
  an unresolved `include_str!`/path, identify the artifact and supply it at the expected
  relative path.
- **Pass criteria:** `cargo build` succeeds with zero TUI source edits.
- **Effort:** S (½ day; expected green — all 11 embedded artifacts were copied).

### A-004: Interrupting an Effect fiber tears down the underlying pi-ai stream
- **Impact if false:** Cancelled runs leak post-cancel `assistant.delta`s (the TUI renders
  stale content) and/or background work accumulates. Fallback: port the old host's
  race-and-abandon semantics + per-`runId` post-cancel delta suppression, and surface
  `upstreamStopCertainty = local_abort_only` (Escape Hatch 2). This is the design the old
  host already uses *because provider abort is unreliable* — so a `fail` here just means we
  adopt that design explicitly rather than relying on clean teardown.
- **Experiment:** Wrap one real `pi-ai` streaming call in `Effect.tryPromise` with an
  `AbortSignal` driven by fiber interruption. Start a stream against a slow/mock provider,
  interrupt the fiber mid-stream, and observe: (a) does the underlying `AsyncIterable`
  terminate, (b) does the HTTP connection abort, (c) are any `assistant.delta`s emitted
  *after* the interrupt?
- **Pass criteria:** Interrupt → underlying stream terminates and NO `assistant.delta` is
  emitted after the cancel point, on every interrupt. (A `fail` triggers Escape Hatch 2.)
- **Effort:** M (1–2 days; needs the S1 pi-ai wrap scaffolded first).

---

_After all four are pass/fail/deferred, merge learnings into the Implementation Plan's Phases,
remove the Assumptions section there, archive this guide, and advance to CONVERGE._
