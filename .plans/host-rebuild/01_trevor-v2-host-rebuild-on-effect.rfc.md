---
number: 01
title: "Trevor V2 Host Rebuild on Effect"
type: migration
status: Draft
author: kevin
date: 2026-06-18
---

# RFC-01: Trevor V2 Host Rebuild on Effect

> **SUPERSEDED IN PART (2026-06-22 pivot).** This RFC's architecture - reuse the Rust TUI unchanged over a
> JSONL-over-stdio wire, gated by a conformance oracle - was superseded by decisions D-013 through D-020.
> The current architecture is browser-only (`apps/web`, React + Vite + Effect) with the host and web app as
> Richter participants over WebSocket, Richter as the durable substrate, the protocol re-owned in Effect
> Schema, and no conformance oracle. Read `implementation.md` for the current plan; this document is retained
> as the original design record. Reversed: D-002 (Rust TUI), D-005/D-008 (conformance oracle), D-006/D-009
> (Bun binary), D-011 (TUI tolerance). OQ5 (protocol) and OQ6 (Richter) are resolved.

## Abstract

This RFC specifies a ground-up rebuild of the Trevor agent **host** — today a
~90K-LOC TypeScript process across 25 subsystems — onto the [Effect](https://effect.website)
library (v3 stable), in a fresh repository (`~/dev/trevorV2`), while reusing the
existing Rust TUI **unchanged**. The host↔TUI boundary is a JSONL-over-stdio wire
protocol pinned by golden fixtures and a runtime contract-hash handshake; because that
boundary is a true language seam, a rewritten host that reproduces the wire stream is
indistinguishable to the TUI. <!-- D-005 --> The rebuild proceeds **one feature at a
time as vertical slices** — each slice delivers its protocol event(s), its host logic,
and a conformance test that proves the exact wire output — burning down a living
inventory (`FEATURES.md`). The safety spine is a **protocol conformance oracle**:
recorded `(ClientCommand → ServerPayload)` transcripts from the old host, replayed
against the new host and compared under a **normalized semantic equality** (volatile
fields normalized; provider responses recorded and replayed, not live).

## Introduction

**Problem.** The current Trevor host is a large, hand-rolled async TypeScript system.
Its hardest parts — provider streaming, cancellation/idle-timeout races, a string-keyed
error taxonomy, factory-based dependency injection, and a callback observability adapter
threaded across ~17 files — are correct but understood only by reading Trevor's own
source. The maintainer wants to (a) re-found the host on documented, community-supported
primitives that raise the project's bus factor, (b) shed multi-user/collaboration scope
that is no longer wanted, and (c) do the rebuild in a cognitively bounded way: one
feature at a time, with a continuously truthful inventory of what is ported, pending,
deferred, or deliberately cut.

**Scope — in.** A new TypeScript host in `~/dev/trevorV2` built on Effect v3, covering
the `KEEP`-tagged host features in `FEATURES.md`: the JSONL transport and command loop,
session/run/turn lifecycle, the agent loop and provider I/O (wrapping `@mariozechner/pi-ai`),
the tool execution core and core tools, persistence/resume, settings and read-models,
deterministic routing (heuristic/fixed), auth/login, prompt-production discovery, doctor,
and workspace switch/list/create. The wire protocol (`packages/protocol`) is reproduced
exactly.

<!-- D-012 --> V2 also adds one **new, wire-invisible** capability: **shell interpolation in
skills & commands** — a single-line `!cmd` and a multi-line ` ```! ` fenced block, executed
at prompt-expansion time and interpolated into the constructed prompt. It extends prompt
expansion, emits no new protocol event, and is trust-gated (see Security Considerations).

**Scope — out.**
- <!-- D-002 --> The Rust TUI (`tui/`) — reused **unchanged**; copied into `trevorV2/tui`.
  This RFC MUST NOT require any TUI source change.
- <!-- D-003 --> All multi-user / collaboration features: control-lease, teams,
  multi-client identity (`clientId`/`ownerId`), shared sessions, workspace leasing
  (`workspace.acquire`). These are `DROP` in `FEATURES.md` §3.
- <!-- D-004 --> Model-led routing classification — `TABLE`d (see `TABLED.md` T-1); V2
  ships deterministic heuristic/fixed routing only.
- <!-- D-001 --> Effect v4 (beta) and `@effect/ai` (alpha) — out; V2 enters on Effect v3
  core and retains `pi-ai`.
- `DEFER`-tagged long-tail subsystems (tangents, loops, LSP, MCP, hooks, retrieval,
  bounded-child/takeover, local admission) — built after the core, not in the first cut.
- The `lease` wire **error family** and its `LEASE_*` codes — dropped with multi-user; the V2
  error taxonomy is the 9-family / 44-code set **minus `lease`** (8 families / 41 codes).

**Motivation — why now.** The host is a long-lived solo project. A documented runtime
(Effect) can be learned from public docs; a private async dialect cannot. The rebuild is
also the cleanest moment to drop multi-user scope, which otherwise threads
lease/authority/ownership plumbing through the entire `server/rpc` layer.

**Context / prior art.** An earlier, deliberately narrow RFC
(`~/dev/trevor/.plans/_maybe/effect-io-adoption/01_*.rfc.md`) proposed adopting Effect
**only** for the I/O core behind a hard Promise boundary, gated by Phase-0 kill tests.
This RFC **supersedes** that one by widening scope to a full host rebuild, while reusing
its two kill gates (Bun/`--compile` compatibility; v3-vs-v4 entry) and generalizing its
"invariant harness" idea into the protocol conformance oracle defined below.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in
RFC 2119.

- **Host / V2 host** — the new TypeScript process built in `~/dev/trevorV2` on Effect v3.
- **TUI** — the existing Rust terminal UI (`tui/`), reused unchanged; spawns the host as
  a child and speaks JSONL over its stdio.
- **The protocol / the wire / the contract** — the JSONL envelope, `ClientCommand` and
  `ServerPayload` unions, registered server-event names, wire enums, error taxonomy, and
  golden fixtures defined in `packages/protocol`. It is the immutable interface.
- **Conformance oracle** — a record/replay harness that captures `(ClientCommand →
  ServerPayload)` transcripts from a reference host and asserts the V2 host reproduces
  the same `ServerPayload` stream under a **normalized semantic comparison**: volatile fields
  (ids, `ts`, durations, float costs, epoch-ms, volatile sha256s, streaming chunk boundaries)
  are normalized, then structure, field names, and remaining values are asserted (so renames
  and missing fields are caught). Provider interactions are **recorded and replayed**, not live.
- **Vertical slice** — the unit of rebuild work: one user-meaningful capability delivered
  end to end (its protocol event(s) + host logic + conformance test), landing green
  before the next slice starts.
- **Control plane** — the host's concurrency/lifecycle/error/DI backbone (command loop,
  run/turn/submission lifecycle, cancellation), as distinct from leaf I/O (provider SDK,
  sqlite, fs, child processes).
- **Effect (v3)** — the `effect` package providing `Effect<A, E, R>`, fibers,
  `Schedule`, `Data.TaggedError`, `Layer`/`Context`, `Stream`, and `Effect.withSpan`.
- **Promise boundary** — the seam where Effect values run to Promises (`Effect.runPromise`)
  and Promises lift into Effect (`Effect.tryPromise`); the stdio read/write edge lives here.
- **Slice S-N** — a numbered slice in the migration sequence (S0…S10+) defined in
  `FEATURES.md` §7.

## Current State

The old host (`~/dev/trevor/packages/agent-host`, ~90K LOC) is plain `async`/`await` over
Promises with hand-rolled primitives:

- **Transport.** The TUI spawns the host (`TREVOR_HOST_CMD`, default
  `bun run …/server/rpc.ts`); the host reads JSONL commands on stdin (`node:readline`) and
  writes envelopes to stdout through a single typed choke point (`emitServerEvent`).
- **Concurrency/cancellation.** `raceWithCancellation` / `raceWithProviderIdleTimeout`
  (`agent/runtime-errors.ts`) hand-roll `Promise.race` with `AbortSignal` listeners and
  `setTimeout`; cancellation is detected by `instanceof`/shape/regex checks.
- **Errors.** A string-keyed `failureKind` taxonomy plus a 44-code / 9-family wire error
  vocabulary, classified at a write choke point.
- **DI.** `AgentRuntimeDeps` plain objects assembled by factory functions; no container.
- **Observability.** A callback `ObservabilityAdapter` with manual `spanId` threading
  across ~17 files.
- **Tooling.** Runtime and tests on Bun; the host ships as a compiled binary via
  `bun build … --compile`.

The boundary is already an executable contract: `packages/protocol` defines the
`ServerPayload`/`ClientCommand` unions, a registered event-name list
(`schema/server-events.json`), one golden fixture per event (`schema/fixtures/*.json`),
and a runtime `contract.current` sha256 handshake the TUI validates (warn-only on
mismatch). The TUI passes unknown event types through silently (forward-compat).

## Target State

A new host whose **control plane is expressed in Effect** and whose **leaf I/O is wrapped
at its edges**, behind a stable Promise boundary at the stdio seam.

- **Transport (Promise boundary).** A small runtime reads stdin lines and writes stdout
  envelopes; inbound commands are lifted into Effect, outbound events are produced by
  Effect programs run to Promises. The single emission choke point is preserved and is
  the only code that writes the wire.
- **Structured concurrency.** Run/turn/submission lifecycle and
  cancellation are modeled with Effect fibers + interruption, so one interrupt
  deterministically tears down the provider stream, the in-flight tool, and any child
  work together. This replaces `raceWithCancellation` / `raceWithProviderIdleTimeout`
  with `Effect.race` / `Effect.timeout` + interruption.
- **Typed errors.** A `Data.TaggedError` taxonomy that maps **1:1 onto the wire error
  enum** (the 9-family / 44-code set minus the dropped `lease` family → **8 families / 41
  codes**), so the compiler proves the host never emits an out-of-vocabulary error.
- **Dependency injection.** `Layer`/`Context` replace the `AgentRuntimeDeps` factories,
  with scoped resource lifetimes for the sqlite handle, provider client, and child
  processes (acquire/release deterministic). Test wiring swaps a `Layer`.
- **Retries.** `Schedule`-based policies for provider retry/backoff and (later) reconnects.
- **Observability.** `Effect.withSpan` provides a causal trace of the agent loop natively,
  replacing manual `spanId` threading; OTel export is `DEFER`-tier.
- <!-- D-001 --> **Provider SDK retained.** `@mariozechner/pi-ai` is kept and wrapped via
  `Effect.tryPromise` (supplying the `AbortSignal` the runtime aborts on interruption).
  No provider-SDK swap during the rebuild.

The host MUST reproduce the wire protocol exactly (envelope shape, event names, cadence,
enums, error vocabulary) and MUST keep the TUI-embedded host artifacts at their paths
(`packages/agent-host/src/provider/login-provider-metadata.json`,
`packages/agent-host/src/prompt-production/slash-command-inventory.json`,
`packages/protocol/schema/*`, `packages/protocol/src/output-style-metadata.json`).

## Migration Strategy

The strategy is **vertical slices in dependency order**, each gated by the conformance
oracle. It is preceded by a cheap Phase-0 kill gate and grounded by building the oracle
first.

### Phase 0 — Kill gates (cheap, decisive)

1. **A-001 (Bun + `--compile`, hard kill — run FIRST).** A non-trivial Effect v3 program
   (exercising fiber interruption) MUST run under `bun test` and from a `bun build …
   --compile` binary with interruption intact. This MUST be validated **before** D-006 is
   committed. If it fails, the real fallback is interpreted `bun run` selected via the
   `TREVOR_HOST_CMD` env override — **no TUI source change** (D-002 holds) — and the
   compiled-binary distribution is reconsidered.
2. **A-002 (v3 entry, soft — non-gating).** Record the v3→v4 entry posture and upgrade cost.
   (Decided: enter on v3 — D-001.) Does not block Phase 2.
3. **A-003 (TUI builds unchanged, hard).** `cargo build` of `trevorV2/tui` MUST succeed
   against the copied protocol + host artifacts, proving the "reuse unchanged" premise
   before any host code exists.
4. **A-004 (pi-ai interruption, hard).** Aborting an Effect fiber MUST actually tear down the
   underlying `pi-ai` stream — no post-cancel `assistant.delta`s. The old host already models
   `upstreamStopCertainty` because provider abort is unreliable; V2 MUST port the
   race-and-abandon semantics and suppress post-cancel deltas by `runId`.

### Phase 1 — Conformance oracle (the safety spine)

Before porting features, build the record/replay harness:
- **Record.** Drive the **old** host with scripted `ClientCommand` sequences (the existing
  smoke scenarios are the seed) and capture the full `(in → out)` JSONL transcript.
- **Replay/compare.** Feed identical input to the V2 host and compare the `ServerPayload`
  stream under a **normalized semantic equality**: a declared normalization step neutralizes
  volatile fields (ids, `ts`, durations, float costs, epoch-ms, volatile sha256s, and
  streaming-delta chunk boundaries — compare coalesced assistant text, not per-chunk splits),
  then structure + field names + remaining values are asserted so renames/missing fields are
  caught. The comparison MUST NOT blanket-strip `correlationId` — the TUI keys startup
  transcript behavior on `correlationId == "session.start"`.
- The per-event golden fixtures in `packages/protocol/schema/fixtures/*.json` are the
  per-event acceptance assertions; the recorded transcripts are the per-flow assertions.

This harness is a permanent artifact and the merge gate for every slice.

### Phase 2 — Vertical slices (S0…S10+)

Defined in `FEATURES.md` §7. Each slice MUST land with its conformance test green:

- **S0 — Transport & handshake:** envelope, `session.start`→`session.started`,
  `contract.current`, `ping` (client) → `pong` (server), stdin-EOF shutdown. *(TUI connects,
  shows an empty session, heartbeat steady.)*
- **S1 — One-shot turn:** `prompt.submit` → `agent.state` → `assistant.delta` →
  `assistant.completed` → `run.metrics.current`; pi-ai wrapped in Effect. *(Streamed reply.)*
- **S2 — Tools:** `tool.*`, `tools.identity.current`; read/edit/bash/rg/glob/web.
- **S3 — Persistence & resume:** sqlite app-db, transcript store, blob store, `session.resume`.
- **S4 — Settings & read-models:** `settings.*`, metrics, usage, progress.
- **S5 — Lifecycle depth:** cancel, retry, follow-up queue, watchdog, error envelopes.
- **S6 — Routing (deterministic):** `route.classifying/resolved/outcome`; fixed posture,
  roles **main** + **ghost** (background ≡ main), each an ordered model array (fallback
  chain, e.g. offline → local); work-kinds, quality tiers, validation/escalation.
- **S7 — Auth/login & offline:** `auth.*`, `offline_*`, connectivity probe.
- **S8 — Prompt production:** `/agents`, `/skills`, slash commands, doctor.
- **S9 — Workspace:** switch/list/create + fingerprints (no acquire).
- **S10+ — Long tail (`DEFER`):** tangents, loops, LSP, MCP, hooks, retrieval,
  bounded-child/takeover, local admission.

A slice MUST NOT begin until the previous slice's conformance test is green. `FEATURES.md`
Status cells MUST be updated as each slice lands (the inventory is the burndown).

### Order rationale

S0–S2 are the minimum to make the TUI demonstrably alive (connect → converse → use tools).
Everything after deepens correctness (S5), adds intelligence (S6), or extends surface
(S7+). The `DROP` set is never built; the `TABLE` set is parked in `TABLED.md`.

## Backward Compatibility

- The wire protocol (`packages/protocol`) MUST NOT change. Envelope shape, registered
  event names, wire enums, and the (non-lease) error vocabulary are reproduced exactly.
- <!-- D-002 --> The Rust TUI MUST remain byte-identical to the copied source. Any pressure
  to change the TUI is a signal that the host diverged from the contract — fix the host.
- The host MUST emit `contract.current` immediately after `session.started` with hashes
  matching the embedded artifacts (or accept the TUI's warn-only mismatch line).
- Dropped features degrade gracefully on the TUI side: their events simply never arrive,
  so the Teams modal and lease/owner chrome stay dark with no TUI change (forward-compat
  via unknown-event pass-through).
- <!-- D-011 --> Because the TUI is reused unchanged, it MAY still **send** commands for
  dropped features (e.g. `controlLease.*`, `/lease`). The host MUST **accept-and-ignore**
  these (never emit an `error` for them) and MUST keep emitting the **non-lease** fields the
  TUI still decodes — session-recovery counts in `sessions.current`, `childAgent.*` /
  background-execution events, and the `session.start` `correlationId` convention. This adds
  **no** multi-user capability; it is defensive tolerance so the unchanged TUI shows no
  spurious error. `background ≡ main` (D-007) collapses only the routing *role* (model
  selection) — the background *execution mode* and its `childAgent.*` events remain.
- The host MUST keep regenerating the two embedded host JSON artifacts at their paths so
  the TUI continues to compile.

## Rollback Plan

- The V2 host lives in a separate repo (`~/dev/trevorV2`); the production host
  (`~/dev/trevor`) is untouched and remains the fallback at all times.
- Per-slice: each slice is a branch whose merge gate is "conformance oracle green." A
  slice that cannot pass within a bounded effort is reverted; the inventory row stays
  `todo`.
- There is no destructive cutover: the TUI can be pointed back at the old host via
  `TREVOR_HOST_CMD` at any time, so "rollback" is changing one env var.

## Risk Assessment

- **Half-migrated stall (high).** A solo maintainer's scarcest resource is continuity. The
  vertical-slice cadence with a green-gate-per-slice keeps the host always-shippable;
  there is no long-lived two-paradigm intermediate because the old host stays whole in its
  own repo. Mitigation: never start a slice before the prior one is green.
- **Effect-dialect drift (medium).** Non-idiomatic Effect would recreate the private-dialect
  problem the rebuild is meant to solve. Mitigation: lean on public Effect patterns; keep
  `Layer`/`Stream`/`withSpan` usage idiomatic; review against the docs.
- **Bun + `--compile` under Effect (high, gating).** If Effect doesn't run in the compiled
  binary the TUI spawns, the distribution model breaks. Mitigation: A-001 is a Phase-0 hard
  kill **run before D-006 is committed**; the fallback is interpreted `bun run` via the
  `TREVOR_HOST_CMD` env override (no TUI change).
- **Conformance non-determinism (high).** Every envelope carries a fresh `ts`/`id`; payloads
  carry float costs, epoch-ms, sha256s, and provider-determined streaming chunk boundaries,
  so byte-equality is unworkable. Mitigation: the oracle is a normalized **semantic** comparator
  over **recorded** (not live) provider interactions, with an explicit normalization spec that
  still catches renames/missing fields and preserves load-bearing fields like the startup
  `correlationId`.
- **pi-ai interruption leak (high).** Aborting the fiber may not terminate `pi-ai`'s
  `AsyncIterable` (provider abort is unreliable — the old host tracks `upstreamStopCertainty`),
  risking post-cancel `assistant.delta`s. Mitigation: spike A-004; port race-and-abandon +
  per-`runId` post-cancel delta suppression.
- **Hidden TUI coupling (medium).** The TUI embeds host artifacts at compile time and may
  couple to event cadence subtleties. Mitigation: A-003 build gate; the fixtures pin
  per-event shape; recorded transcripts pin cadence.
- **Scope creep into DEFER/TABLE (low/medium).** Mitigation: `FEATURES.md` decisions and
  this RFC's scope-out list are the gate; DROP is never built, TABLE stays parked.

## Validation & Testing

- **Per-event:** every emitted event MUST validate against its golden fixture
  (`schema/fixtures/*.json`) and its `payload-schemas.json` entry.
- **Per-flow:** every slice MUST ship a conformance test that replays a recorded transcript
  and asserts **normalized semantic equality** of the `ServerPayload` stream (volatile fields
  normalized; structure/field-names/values otherwise asserted, including the startup
  `correlationId` convention).
- **Phase gates:** A-001 (Effect under bun `--compile`, run first), A-003 (`cargo build` of
  the copied TUI succeeds), and A-004 (pi-ai interruption tears down the stream) MUST pass
  before/early in Phase 2; A-002 (v3 entry) recorded (non-gating).
- **Live smoke:** the existing TUI smoke suite (run serially) MUST pass against the V2 host
  for the slices implemented so far.
- **Truthfulness:** `FEATURES.md` Status cells MUST reflect only what is actually green; a
  slice is not "done" while its conformance test is red or edge cases are unhandled.

## Security Considerations

- **Trust boundaries.** The TUI is a trusted local child; the host trusts its stdin only
  as a local IPC channel. Inbound `ClientCommand`s MUST be validated (shape + enum
  membership) before dispatch; malformed input MUST NOT crash the host and MUST NOT emit a
  malformed wire line (the TUI surfaces malformed host output as a visible decode failure).
- **Credentials.** Provider credentials live in the shared `~/.pi/auth.json` (0600 file /
  0700 dir, atomic writes). The host MUST preserve those file modes and atomicity; OAuth
  tokens MUST NOT be written world-readable.
- **Tool blast radius.** Write-capable tools MUST keep the D-035 write-confinement floor
  (workspace / `$TMPDIR` / `~/.trevor`) and the D-034 bash deny-floor. The shell-based
  secret resolver (`!command`) MUST remain opt-in (config-gated).
- **Secret redaction.** Tool telemetry and observability spans MUST redact sensitive
  fields (command, content, env values) to length+hash before emission/persistence.
- **Dropping multi-user removes a trust surface.** With no control-lease/multi-client, the
  host serves exactly one local client; the authority/lease checks are deleted rather than
  reimplemented, shrinking the attack surface.
- <!-- D-012 --> **Shell interpolation in skills & commands (NEW capability, footgun).**
  Skill/command files MAY embed `!cmd` (single-line) or ` ```! ` (multi-line) shell, executed
  host-side at prompt-expansion time. This is arbitrary code execution from discovered files,
  so it MUST be **off by default** and gated by BOTH an opt-in config flag AND per-file sha256
  trust (the hook-trust model). It MUST honor the D-034 bash deny-floor, a timeout, an output
  cap, the workspace cwd, env hygiene, and telemetry redaction. It is distinct from the
  model-invoked `bash` tool — this runs during expansion, before the model sees the prompt.

## Timeline

No calendar dates — there is no external deadline. This section orders phases and the
go/no-go gate between each; effort is relative, not scheduled.

1. **Phase 0 — kill gates** (small). Gate: A-001 (Effect under bun `--compile`) and A-003
   (copied TUI builds) MUST pass; A-002 (v3 entry) recorded. A failed hard kill stops the plan.
2. **Phase 1 — conformance oracle** (small–medium). Gate: the harness can record an old-host
   transcript and replay+diff it against a stub host.
3. **S0 — transport & handshake** (small). Gate: TUI connects, shows a session, heartbeat
   steady; S0 conformance test green.
4. **S1–S2 — turn + tools** (medium). Gate: streamed reply + tool calls render; conformance
   green. This is the "demonstrably alive" milestone.
5. **S3–S5 — persistence, settings, lifecycle depth** (medium). Gate: resume works;
   cancel/retry/watchdog correct.
6. **S6 — deterministic routing** (medium). Gate: route rows + work-kind selection.
7. **S7–S9 — auth/offline, prompt-production, workspace** (medium).
8. **S10+ — long tail (`DEFER`)** (open-ended). Built opportunistically once the core is stable.

Go/no-go between every phase and every slice: the prior slice's conformance test MUST be
green before the next begins.

## Open Questions

1. **Runtime/toolchain — RESOLVED, pending A-001 (<!-- D-006 --> D-006, <!-- D-009 --> D-009).**
   Bun, distributed as a compiled binary (`bun build … --compile`). A-001 MUST validate Effect
   under `bun --compile` **before** this is committed; if it fails, fall back to interpreted
   `bun run` via the `TREVOR_HOST_CMD` env override (no TUI source change).
2. **Effect Layer topology (OPEN).** How to carve the `Layer`/`Context` graph — one root app
   layer vs. per-subsystem layers (Persistence, Provider, Tools, Routing, Observability).
   Internal structure, invisible to the TUI; safe to settle once S0–S3 take shape.
3. **Conformance-oracle harness shape (OPEN, decide in Phase 1).** Expected to resemble the
   current smoke harness. Where it lives, how transcripts are recorded, and the
   non-determinism allowlist are deferred. See also OQ6 (Richter).
4. **Routing roles & posture — RESOLVED (<!-- D-007 --> D-007).** Fixed posture (no model-led
   classifier). Role set is **main** and **ghost** only; **background ≡ main**. Each role is
   an **ordered array of models** (a fallback chain), so e.g. an offline transition can fall
   through to a local model. Heavy focus on local + cloud models with fallbacks. (Old roles
   `router` / `vision` / `tool_lesson` are moot with the classifier tabled and
   bounded-helpers deferred.)
5. **Re-own vs. copy `packages/protocol` (OPEN).** Keep the byte-identical copy, or
   re-implement the TS side idiomatically (Effect `Schema`?). Affects whether `Schema` enters
   the stack. Left open.
6. **Optional Richter integration (OPEN).** "Richter" — a durable-sessions application — MAY
   optionally back V2's session durability, instead of or in addition to the sqlite app-db +
   JSONL transcript store (support either or both). Undecided; affects the persistence layer
   (H-130…H-132) and possibly the session model. Park until the core persistence slice (S3).

## References

**Normative**
- `~/dev/trevorV2/FEATURES.md` — the complete two-sided inventory and slice burndown
  (host features H-001…H-174, the TUI surface, the protocol appendix, the S0…S10+ order).
- `~/dev/trevorV2/TABLED.md` — T-1, tabled model-led routing classification.
- `~/dev/trevorV2/packages/protocol/` — the wire contract this RFC reproduces exactly.
- [Effect documentation](https://effect.website/docs) — the runtime under adoption (v3 core).

**Informative**
- `~/dev/trevor/.plans/_maybe/effect-io-adoption/01_*.rfc.md` — the earlier narrow Effect
  RFC this one supersedes; source of the Phase-0 kill gates and the invariant-harness idea.
- `~/dev/trevor/CONTEXT.md` — the inherited domain vocabulary.
- [Effect v4 beta recap](https://effect.website/blog/effect-v4beta-launch-to-may-recap/) —
  context for the v3-vs-v4 entry posture (Open Question / A-002).
