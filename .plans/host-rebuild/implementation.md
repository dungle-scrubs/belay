# Trevor V2 Host Rebuild - Implementation Plan

> Canonical decisions live in `plan.db` (D-001…D-020); `<!-- D-NNN -->` markers tag decided claims.
> **2026-06-22 pivot.** This plan was re-pointed from the original Rust-TUI / stdio architecture to a
> browser-only + Richter-participant architecture. The RFC (`01_…rfc.md`), `spike-guide.md`, and
> `FEATURES.md` retain the original design as historical context behind a superseding header; **this
> document is the current plan.**

## Architecture

<!-- D-013 --> The frontend is a **browser web app** (`apps/web`: React 19 + Vite + Effect). There is no
Rust TUI. <!-- D-014 --> The host and the web app are **both Richter participants**: each connects to the
Richter durable-session service over **WebSocket** (`/sessions/{id}/stream`) and they communicate only
through Richter's durable, ordered event log. Nothing spawns the host; there is no direct host-web boundary.

```
  apps/web (React + Vite + Effect)        apps/agent-host (Node + Effect)  [Slice 1+]
        |  WS participant                        |  WS participant
        +------------>  Richter  <---------------+
              /sessions/{id}/stream  +  REST /sessions, /sessions/{id}/events
        durable substrate (Postgres); local Docker :3025; prod mac-mini over Tailscale
```

- <!-- D-014 --> **Transport.** Replay-then-tail over WS; publish via REST `POST /sessions/{id}/events`
  (Slice 0) and the WS `publish` command (later). The host drains `user.message`-class events and
  publishes assistant/tool events; the browser renders them.
- <!-- D-017 --> **Protocol.** Re-owned in Effect `Schema`, grown one event at a time
  (`apps/web/src/richter/wire.ts`). Trevor's semantic events (assistant.delta, tool.*) ride as **opaque
  payloads inside Richter `sessionEvents`**; Richter stays generic. The frozen Rust-TUI contract in
  `packages/protocol` is not reused.
- <!-- D-019 --> **Participants are capability-scoped.** Exactly one filesystem-authority runtime per
  session (lightweight control lease, deliberate handoff); browser clients and future observer/producer
  participants (skill-watcher, memory agent) are first-class with no lease.
  <!-- D-003 --> Multi-USER stays dropped; single-user multi-DEVICE returns.
- <!-- D-001 --> **Effect v3** for the control plane and the decode boundary;
  <!-- D-018 --> **pnpm + Node/tsx** workspace (Biome, Lefthook, tsc, Vite). A Bun-compiled host is a
  later optional call, not a gate.
- <!-- D-016 --> **Greenfield, not a port.** No conformance oracle; ordinary per-slice tests.

### Key Constraints

| Constraint | Impact |
|---|---|
| <!-- D-013 --> Browser-only frontend | No TUI; `apps/web` is the renderer and owns presentation |
| <!-- D-014 --> Richter-participant transport (WS) | Host + web both connect to Richter; no stdio; no host-web boundary |
| <!-- D-015 --> Richter is the durable substrate | Sessions/events/participants persist in Richter; local Docker :3025 |
| <!-- D-017 --> Protocol re-owned in Effect Schema | Grown per slice; trevor events ride as payloads in Richter events |
| <!-- D-016 --> No conformance oracle | Per-slice tests; not byte-compatible with the old host |
| <!-- D-019 --> Capability-scoped participants | One filesystem-authority runtime/session; observers/clients lease-free |
| <!-- D-004 --> Routing classification tabled | Deterministic heuristic/fixed routing only |
| <!-- D-007 --> Roles = main + ghost | Each an ordered model array (offline -> local fallback) |
| <!-- D-010 --> Provider abort unreliable | Race-and-abandon + per-runId post-cancel delta suppression (Slice 2) |
| <!-- D-012 --> Shell interpolation in skills/commands | New host capability H-175, gated; later slice |

### Module boundaries

- **`apps/web/`** - browser UI. `src/richter/` = wire schema (Effect Schema) + WS client + React hook;
  `src/` = views. <!-- D-013 -->
- **`apps/agent-host/`** - the host (Slice 1+): Node + Effect Richter participant; agent loop; provider
  adapters (LM Studio, pi-ai); tools. <!-- D-014 -->
- **Richter** (external, `~/dev/richter`) - durable substrate; not modified by trevor, which attaches as a
  generic participant. <!-- D-015 -->
- **Legacy (superseded):** `packages/protocol` (old host-TUI wire), `packages/agent-host` (TUI-embedded
  JSON), `FEATURES.md` sections 1/5/6/7 are superseded; the TUI-era packages have been removed. The host FEATURE inventory `FEATURES.md`
  section 4 (H-001…H-174) remains the backlog.

## Assumptions

| Code | Assumption | Status |
|---|---|---|
| A-002 | Effect v3 viable for the project horizon | recorded (D-001) |
| A-004 | Interrupting an Effect fiber tears down the pi-ai stream | untested; validated at Slice 2 |
| A-005 | Node+Effect host packages as a spawnable artifact (compiled binary or bundled Node) for a Tauri sidecar | untested; validated at Phase 3 (re-opens A-001) |
| ~~A-001~~ | ~~Effect under `bun --compile`~~ | retired - no Bun binary (D-018) |
| ~~A-003~~ | ~~copied Rust TUI builds unchanged~~ | retired - no TUI (D-013) |

## Phases

### Phase 0 - Foundations (DONE)
- pnpm workspace (Biome, Lefthook, tsc, Vite, React 19, Effect 3); `tsc --noEmit` clean, `vite build` green.
- Richter substrate running in Docker on `:3025` (richter repo branch `trevor-sessions`); schema migrated;
  durable event round-trip verified.

### Phase 1 - Browser-first slices <!-- D-020 -->
- **S0 - browser <-> Richter** (in progress): `apps/web` connects to a session, replay-then-tail, renders
  the event log, publishes a `user.message`. A reload reconnects and replays (durability proof). No host,
  no model.
- **S1 - host <-> Richter echo:** minimal `apps/agent-host` joins the same session as a participant; on each
  `user.message` it publishes a canned `agent.output`. Establishes the host's emit -> appendEvent choke
  point and participant identity/lease.
- **S2 - real turn via LM Studio qwen:** the echo becomes a real completion against LM Studio qwen3.6-27B
  (local `/v1`), streamed as `assistant.delta* -> assistant.completed` (trevor events as payloads).
  <!-- D-010 --> A-004 is validated here.
- **S3 - pi-ai GPT-5.5 + provider switch:** add the pi-ai adapter -> GPT-5.5 and a provider setting; main
  role = ordered array [local qwen, GPT-5.5]. <!-- D-007 -->

### Phase 2+ - Host feature backlog
The `FEATURES.md` section 4 host inventory (H-001…H-174: session/run/turn lifecycle, agent loop, tools,
routing, persistence-in-Richter, settings, auth, prompt-production, doctor, workspace, and shell
interpolation H-175) remains valid as the post-S3 backlog, re-sequenced onto the Richter transport.
<!-- D-003 --> Multi-user features (`controlLease.*`, teams, `workspace.acquire`, multi-client identity)
stay dropped; the capability-scoped filesystem lease (D-019) is the only authority mechanism.

### Phase 3 - Desktop shell (later) <!-- D-021 -->
Later phase, after the Phase 2+ host backlog. Captured here as architecture + decisions; **not milestone-
decomposed yet** - decompose at phase entry. Package `apps/web` as a **self-contained desktop app**: one
window managing many sessions (sidebar/tabs), each session bound to a cwd like a single-process Claude Code
harness; different views/devices may subscribe to the same session (lease-free Richter clients).

- <!-- D-021 --> **Shell = Tauri v2.** The OS webview renders `apps/web`; the Tauri (Rust) core is the
  **host supervisor**. Electron (built-in Node) was considered and rejected for heft/coupling.
- <!-- D-022 --> **One host runtime per session/cwd.** The supervisor spawns / restarts / tears down one host
  process per open session; a single multiplexing host service is rejected. Clean 1:1 with the D-019
  per-session filesystem-authority lease. Multi-view fan-out is unaffected - extra views are lease-free
  Richter clients on the same `/sessions/{id}/stream`.
- <!-- D-023 --> **Supervision is not communication (D-014 amended).** The Tauri core MAY spawn hosts, but the
  web/UI client still talks only to Richter. Spawning is a lifecycle concern; no direct host-web
  *communication* boundary is introduced, so D-014's decoupling holds.
- <!-- D-024 --> **Spawnable host artifact required.** Tauri spawns the host as a sidecar (`externalBin`), so
  the Node+Effect host must ship as a standalone binary or with a bundled Node. This **elevates the D-018
  compiled-host from optional to a dependency of this phase**; the mechanism (bun --compile / Node SEA / pkg
  vs bundled Node) is open and decided at phase entry (A-005, re-opening retired A-001).

**Packaging deltas in `apps/web`** (apply at phase entry, not now):
- The dev-only Vite proxy (`/sessions` -> `localhost:3025`, `ws: true`) disappears in a packaged app. The
  Richter client must target an **absolute, runtime-configurable Richter URL** (local Docker vs mac-mini over
  Tailscale), injected by the shell rather than baked at build.
- The webview **CSP / Tauri capability allowlist** must permit the Richter REST + WS origin.
- Set Vite `base: './'` (or use the Tauri asset protocol) so the built bundle loads outside an HTTP dev server.

## Risks
- **Richter coupling.** Trevor depends on a running Richter; mitigated by Docker-local dev and Richter being
  generic (no trevor-specific changes - it attaches as a participant).
- **pi-ai interruption leak (D-010).** Validated at Slice 2; fallback is race-and-abandon + per-runId
  post-cancel delta suppression.
- **Effect-dialect drift.** Keep Effect to justified boundaries (Schema decode, host control plane); plain
  React/TS elsewhere so an Effect island does not fight React.
- **Same-cwd contention (Phase 3, D-022).** "Multiple versions of the same cwd" lets two sessions hold
  filesystem authority over one directory at once (two harnesses, like two Claude Code instances in one repo,
  can stomp each other). The D-019 lease is per-session, not per-cwd, so it does not arbitrate cwd-level
  contention. Accepted as a deliberate user action; revisit with a cwd-level advisory lock if it bites.

---
_Last re-pointed 2026-06-22 (browser/Richter pivot, D-013…D-020). Supersedes the original Rust-TUI/stdio plan._
_Desktop-shell Phase 3 added 2026-06-22 (Tauri self-contained app, per-cwd host supervisor, D-021…D-024 / A-005)._
