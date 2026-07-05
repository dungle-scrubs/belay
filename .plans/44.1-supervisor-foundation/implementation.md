# Supervisor Foundation - Implementation Plan

## 0. Hard Dependencies

- [x] D-085 project launcher - `apps/trevor-cli/src/launch.ts`, `platform.ts`, `host-registry.ts`, `project.ts`, `identity.ts` already resolve a project root, derive/persist a session id, ensure shared services, lock per session, and spawn/reuse an agent-host. This plan extracts that logic; it does not reinvent it.
- [x] `03-filesystem-root-taxonomy` - launcher records (`projects.json`, `hosts.json`, `locks/`) live under `TREVOR_STATE_HOME`; the supervisor reads/writes only through `@trevor/session/node-paths`, never new ad-hoc paths.
- [x] Existing session transport contract - web and host communicate only through the local session-store / Richter via `@trevor/session`. The supervisor is subject to the same rule: **supervision is not communication** (mirrors `.plans/48-desktop-shell-tauri` D-constraint).
- [x] `file.index.requested` / `file.index.result` side-channel (`packages/session/src/protocol.ts`, host handler `apps/agent-host/src/main.ts`) - the prior-art shape for a browser-published request answered over the session log. The new supervisor requests mirror it.

## Provenance (plan 44 M1 residual audit)

This plan and its siblings (`44.2-browser-folder-sessions`, `44.3-supervisor-lifecycle-glue`) are the concrete
extraction of the residual D-061 "session manager" work. The M1 audit mapped every D-061 clause to an owning,
completed plan - project launcher (D-085), explicit resume (D-090), session sidebar (D-093), lifecycle /
archive / delete / fork / handoff (D-094), archive browser (`04-archive-browser-and-delete`), worktree
hardening (`01-managed-worktree-hardening`). The only **unowned** residue was *browser-created folder
sessions* and *supervisor lifecycle glue*. Auditing surfaced a premise error in plan 44's own M2: there is no
browser-reachable launcher/supervisor boundary today (`trevor` is a fire-and-exit CLI; the browser reaches
only session-store + blob-store, neither of which spawns a host). This plan builds that missing boundary.
Plan 44 is retired now that its residue is extracted here.

## 1. Architecture

Today the launcher is a **per-invocation CLI process**: `trevor` resolves a workspace, ensures the shared
services, spawns/reuses one agent-host, opens the browser, and exits. There is no long-running process the
browser can ask to start a host, and the browser can only reach session-store + blob-store over HTTP/Richter -
neither spawns a host. So "pick a folder in the browser and a host boots for it" needs two new pieces that
this plan builds and 44.2 / 44.3 consume:

1. **`@trevor/launcher`** - a pure launcher core extracted from `apps/trevor-cli`. Project-root resolution,
   session-id derivation/persistence, host reuse/spawn decisions, ownership records, and lock handling become
   a reusable module over an injected platform, callable by the CLI **and** the supervisor (**and**, later,
   the plan-48 desktop core). The CLI keeps only its arg parsing, debug wiring, and `main.ts`.
2. **`trevor supervisor`** - a small long-running local process that subscribes to a reserved **control
   session** on the session log and, on a browser-published request, calls `@trevor/launcher`. It is the one
   persistent local actor that can spawn a host on demand, pop the native folder picker, and read the project
   registry - all answered back over the session log, never over a private channel.

The browser talks to the supervisor exactly the way it talks to a host: it publishes a typed request event to
a session and reads the typed result event. Three request/result pairs are added, each modeled on
`file.index.requested`/`file.index.result`:

| Request (browser -> control session) | Result (supervisor -> control session) | Purpose |
|---|---|---|
| `session.launch.requested` `{ root, requestId }` | `session.launch.result` `{ requestId, sessionId, status, error? }` | Spawn-or-reuse a host for `root`; return the session id to navigate to. |
| `folder.pick.requested` `{ requestId }` | `folder.pick.result` `{ requestId, path?, cancelled }` | Host-driven native OS folder picker; returns a real POSIX path. |
| `projects.list.requested` `{ requestId }` | `projects.list.result` `{ requestId, projects: [{ root, sessionId, updatedAt }] }` | Recency-sorted recent project roots from `projects.json`. |

The **launch result carries the new session's id**; the freshly spawned host announces `host.online` on *its
own* session, which the browser (44.2) awaits before navigating. This keeps the control session purely a
request/response side-channel and reuses the existing presence path unchanged.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Supervision is not communication | The supervisor may spawn hosts, pop dialogs, and read the registry, but every browser<->supervisor exchange goes through the session log. No private IPC, no bespoke socket. |
| Richter-only side-channel | New events reuse the `file.index` request/result shape and travel on the session transport; no new HTTP route spawns processes. |
| One host per session/cwd | The supervisor reuses `@trevor/launcher`'s existing reuse/spawn/replace-stale decision; it never forks a second host for a live workspace. |
| Reuse launcher semantics, do not fork | The extracted core is the single source of project/session identity and host ownership for both the CLI and the supervisor. |
| Native picker is local + best-effort | The native dialog opens on the supervisor host's display, so it is offered only when the supervisor is local (the normal case) and degrades to paste-a-path when it is not. |
| Storage taxonomy | Launcher records stay under `TREVOR_STATE_HOME` via `@trevor/session/node-paths`; the supervisor adds no new roots. |

### Boundaries

- **`packages/launcher`** (`@trevor/launcher`) owns pure launch orchestration: `resolveProjectRoot`,
  `resolveSession`, `projectSessionId`, `decideHostAction`, host-registry read/write, lock acquisition, and
  the `launch(platform, options)` entry - all over an injected `LauncherPlatform` so the node IO stays
  swappable and testable.
- **`apps/trevor-cli`** keeps CLI concerns only (arg parsing, `runOpen`, debug/restart, `main.ts`) and imports
  `@trevor/launcher` for everything it used to own inline. Its observable behavior is unchanged.
- **`apps/trevor-cli` (supervisor command)** hosts the `trevor supervisor` subprocess: subscribe to the
  control session, dispatch requests to `@trevor/launcher` + the native picker + the registry reader, publish
  results. The supervisor is started as one more **ensured shared local service**, alongside session-store /
  blob-store / web, so whenever the stack is up the browser can reach it.
- **`packages/session`** owns the three new protocol event schemas + the reserved control-session id constant,
  so browser and supervisor share one typed contract.

### Observability

Supervisor actions are runtime/transport behavior and get first-class diagnostics:

- launch dispatch: requestId, target root, resolved session id, reuse-vs-spawn-vs-replace-stale decision, host
  pid, outcome;
- native picker: requestId, cancelled-vs-path (path itself is user-chosen, not secret, but logged at debug);
- registry read: count returned;
- failures: unresolvable/nonexistent root, spawn denied, native picker unavailable (non-local / no GUI),
  control-session disconnect - each a structured failure result on the control session, never a silent drop;
- redaction: never log provider secrets or env-expanded auth values in supervisor logs (reuses the host's
  redaction rules).

## 2. Current State

`apps/trevor-cli/src/launch.ts` `launch()` already orchestrates the full happy path but is entangled with CLI
concerns and lives in an app, not a package. `platform.ts` mixes the platform *interface* with its node
implementation and the `buildHostSpawnCommand` details. `host-registry.ts`, `project.ts`, and `identity.ts`
are already close to pure but import app-local paths. Nothing subscribes to the session log to *offer* a
launch; nothing enumerates arbitrary directories to *pick* a new folder; and `projects.json` is launcher-owned
local state the browser cannot read. This plan closes exactly those three gaps.

## 3. Phases

### Phase 1: Extract the launcher core

**Goal:** `@trevor/launcher` exists and both the CLI and tests drive launches through it, with the CLI's
observable behavior unchanged.

#### M1: Extract `@trevor/launcher`

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add characterization tests pinning current `launch()` behavior for the three paths - new project
     (no `projects.json` entry -> derive id -> spawn), resume (registry hit -> reuse a live host), and
     replace-stale (recorded pid dead -> replace) - driving a fake `LauncherPlatform`.
  2. GREEN: Create `packages/launcher` (`@trevor/launcher`) and move `launch`, `resolveProjectRoot`,
     `resolveSession`, `projectSessionId`, `decideHostAction`, host-registry, and lock logic into it over the
     injected platform; re-point `apps/trevor-cli` imports; the CLI keeps only arg parsing / `runOpen` /
     debug / `main.ts`.
  3. RED: Add a test proving CLI and a non-CLI caller resolve the *same* project root and session id for the
     same cwd (identity is shared, not duplicated).
  4. GREEN: Expose a minimal `LauncherPlatform` port so a non-CLI caller (the supervisor, later a desktop
     core) can call `launch()` without importing CLI-only code.
  5. REFACTOR: Split the platform *interface* from its node implementation; keep `buildHostSpawnCommand`
     internal to the node platform; add a module-level comment documenting what `@trevor/launcher` owns.

### Gate 1->2

- [ ] `@trevor/launcher` builds and typechecks as a workspace package.
- [ ] `apps/trevor-cli` behavior is unchanged (its existing tests pass unmodified).
- [ ] CLI and a non-CLI caller share project/session identity in tests.

### Phase 2: The supervisor contract

**Goal:** The three request/result event pairs and the reserved control-session id are typed in
`packages/session` and round-trip.

#### M2: Supervisor protocol events

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Add schema + round-trip tests for `session.launch.requested`/`result`, `folder.pick.requested`/
     `result`, and `projects.list.requested`/`result`, including the `requestId` correlation field.
  2. GREEN: Define the six events + the reserved control-session id constant in `packages/session/src/protocol.ts`.
  3. RED: Add a test that an unknown/malformed supervisor request is rejected at the schema boundary (no
     partial dispatch).
  4. GREEN: Validate requests at the boundary before dispatch.
  5. REFACTOR: Factor the request/result correlation into the existing `file.index` side-channel helper rather
     than a parallel one.

### Gate 2->3

- [ ] All six events validate and round-trip.
- [ ] `requestId` correlates a result to its request.
- [ ] Malformed requests are rejected, not partially handled.

### Phase 3: The supervisor daemon

**Goal:** A running `trevor supervisor` turns control-session requests into real launches, folder picks, and
recents, over the session log only.

#### M3: Launch dispatch

- **Dependencies:** M1, M2
- **Effort:** M
- **Tasks:**
  1. RED: Add an integration test: with the supervisor subscribed to the control session, publishing
     `session.launch.requested { root }` drives `@trevor/launcher` (fake platform) and publishes
     `session.launch.result` with the resolved session id and `status: "launched" | "reused"`.
  2. GREEN: Implement `trevor supervisor` - subscribe to the control session, dispatch launch requests to the
     launcher core, publish results.
  3. RED: Add a test that the supervisor is ensured-running as a shared local service by the launcher stack
     (started once, reused if already up).
  4. GREEN: Register the supervisor as a fourth ensured shared local service in the launcher stack.
  5. REFACTOR: Consolidate dispatch so each request type has one handler; enforce Richter-only (no private
     channel).

#### M4: Native folder pick + recents

- **Dependencies:** M3
- **Effort:** S
- **Tasks:**
  1. RED: Add a test that `folder.pick.requested` invokes the native picker (stubbed) and returns its POSIX
     path, and that a cancel returns `{ cancelled: true }`.
  2. GREEN: Implement the native picker via `osascript -e 'choose folder'` (macOS), guarded to a local
     supervisor; publish `folder.pick.result`.
  3. RED: Add a test that `projects.list.requested` returns `projects.json` entries recency-sorted by
     `updatedAt`, and an empty list when the registry is absent.
  4. GREEN: Implement the recents reader over `@trevor/session/node-paths` `projects.json`.
  5. REFACTOR: Centralize the local-only guard + registry read; document the native-picker degradation
     (non-local -> unavailable, browser falls back to paste-a-path).

### Gate 3

- [ ] A control-session launch request spawns/reuses a host and returns its session id.
- [ ] Native folder pick returns a real path locally and reports unavailable when non-local.
- [ ] Recents come back recency-sorted from `projects.json`.
- [ ] Every exchange is on the session log; no private IPC.

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Extraction changes CLI behavior | high | medium | Characterization tests (M1.1) pin the three launch paths before the move; CLI's existing tests must pass unmodified. | Launcher |
| Supervisor becomes a private app protocol | high | medium | Every exchange is a typed session-log event; tests assert no non-session channel. | Supervisor |
| Native picker unavailable (non-local / headless) | medium | high | Local-only guard + explicit `unavailable`; 44.2 falls back to paste-a-path. | Supervisor |
| Duplicate host on concurrent launch requests | medium | medium | Reuse `@trevor/launcher`'s existing per-session lock + `decideHostAction`. | Launcher |
| Supervisor lifecycle (crash / not started) | medium | medium | Ensured-service start; 44.3 owns the browser-visible recovery states. | Supervisor |

## 5. Escape Hatches

1. **If a clean package extraction is too large for one cut:** land `@trevor/launcher` as a thin re-export
   facade over the existing `apps/trevor-cli` modules first, then move the implementations, keeping the CLI
   green throughout.
2. **If the native picker is fragile:** ship recents + paste-a-path only (folder icon hidden) and treat the
   native dialog as a follow-up; 44.2's UX already degrades to this.
3. **If an ensured-service supervisor is too much for first cut:** start the supervisor from `trevor` on the
   interactive path only, and surface "supervisor not running" as a 44.3 recovery state.

## 6. Progress Report Accounting

The progress report is `.plans/44.1-supervisor-foundation/progress-report.md`. It tracks only the launcher-core
extraction, the supervisor protocol, and the supervisor daemon. The browser picker UI is 44.2; the recovery
states are 44.3.

## 7. Validation Commands

```bash
pnpm --filter @trevor/launcher test
pnpm --filter @trevor/trevor-cli test
pnpm --filter @trevor/session test
pnpm test -- --project e2e
pnpm typecheck
pnpm lint
```

## 8. Decisions

Canonical decisions are in `.plans/44.1-supervisor-foundation/plan.db`. Key decisions carry `<!-- D-NNN -->`
markers in this document.

<!-- D-001 --> Build a minimal, self-contained supervisor now rather than depending on plan 48's desktop core.

<!-- D-002 --> Extract the launcher core into a new `@trevor/launcher` package, callable by CLI and supervisor.

<!-- D-003 --> The supervisor runs as a fourth ensured shared local service; the browser reaches it via a reserved control session on the session log.

<!-- D-004 --> Add three request/result event pairs (`session.launch`, `folder.pick`, `projects.list`) modeled on the `file.index` side-channel; the launch result carries the new session id and the new host announces `host.online` on its own session.

<!-- D-005 --> The native folder picker is supervisor-driven via `osascript choose folder`, local-only and best-effort, degrading to paste-a-path when non-local.
