# Desktop Shell Tauri - Implementation Plan

## 0. Hard Dependencies

- [x] `03-filesystem-root-taxonomy` - desktop-owned durable state, debug state, launcher records, and temporary files must use the established storage roots.
- [x] Existing D-085 launcher and host registry - `apps/trevor-cli/src/launch.ts`, `host-registry.ts`, and `project.ts` already define project root resolution, session id mapping, host reuse/spawn, locks, and shared service readiness.
- [x] Existing session transport contract - web and host communicate through local session-store or Richter via `@trevor/session`; desktop supervision must not become an IPC shortcut.
- [x] Existing local services - web, session-store, blob-store, and agent-host already run as separate workspace apps in development.
- [ ] Spawnable host artifact - the Node + Effect host must ship as a sidecar artifact for Tauri, either as a standalone binary or bundled Node runtime.
- [ ] Desktop packaging decision - choose the app packaging/signing/update path for macOS first, with room for Windows/Linux later.

## 1. Architecture

Trevor desktop is a Tauri v2 shell around the existing web UI. The OS webview renders `apps/web`; the Rust/Tauri core owns local desktop lifecycle: windowing, app menu/tray if needed, shared-service readiness, per-session host supervision, sidecar launching, and desktop packaging. It does not become the application protocol.

The invariant from the browser/Richter pivot stays intact: web and host remain session-log participants. The webview talks to the local session-store or Richter over the same HTTP/WebSocket session transport it uses in browser mode. The host publishes events to that same log. Tauri can spawn and supervise processes, inject runtime config, and report lifecycle status, but it must not pass prompts, tool results, or transcript data through private Tauri IPC.

The desktop product shape is one desktop app managing many sessions. Sessions remain bound to project roots/cwds through the same project identity model as the CLI launcher. Opening a project/session starts or reuses exactly one matching agent-host runtime. Extra windows/views may attach as lease-free clients, but only the host runtime for a session answers turns.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Tauri v2 shell | Electron remains rejected; desktop shell uses Tauri v2. |
| Supervision is not communication | Tauri may spawn services/hosts, but web and host still communicate only through session transport. |
| One host per session/cwd | Desktop supervisor reuses or starts one agent-host runtime per open project session. |
| Reuse launcher semantics | Project root resolution, session id mapping, host ownership, and locks should share logic with D-085 rather than fork. |
| Spawnable host sidecar | Agent host must be packaged as an executable sidecar or with bundled Node. |
| Runtime-configured backend URL | Desktop web build cannot depend on the dev-only Vite proxy. |
| Storybook not sufficient | This is shell/lifecycle work; validation needs desktop smoke/e2e in addition to web tests. |

### Boundaries

- `apps/desktop` or equivalent owns the Tauri app, Rust commands, sidecar config, desktop window lifecycle, runtime config injection, and packaging.
- `apps/web` remains the React UI. It receives runtime session/backend/blob URLs through a desktop-safe config path and continues to use the same session transport.
- `apps/trevor-cli` owns reusable launcher logic today. Desktop should extract or share pure launcher/session/host registry modules rather than copy behavior.
- `apps/agent-host` remains Node + Effect. This plan defines how it becomes a spawnable sidecar artifact, not a rewrite of the host runtime.
- `apps/session-store` and `apps/blob-store` remain local shared services unless a later desktop phase explicitly embeds or replaces them.
- `packages/test-kit` should grow desktop smoke helpers only where they can be reused by CI/e2e.

### Observability

Desktop supervision needs first-class diagnostics:

- service lifecycle events: session-store, blob-store, web asset serving, host spawn/reuse/restart/exit;
- per-session host records: session id, project root, pid, command/artifact path, startedAt, health/presence, restart count;
- sidecar failures: missing executable, spawn denied, crash, port conflict, backend unreachable, CSP/capability violation;
- user-visible surfaces: startup state, host starting/restarting/offline state, Doctor desktop area, logs under the debug state root;
- redaction: never log provider secrets, env-expanded auth values, OAuth tokens, or prompt content in desktop supervision logs.

## 2. Current State

The browser-era launcher already knows how to resolve a project root, derive/persist a session id, ensure shared local services, lock per session, spawn/reuse an agent-host, wait for `host.online`, and open a browser URL.

The current web app relies on Vite dev proxy behavior for local `/sessions` routing. The Phase 3 desktop shell requires a production web build that can connect to an absolute runtime-configurable session backend and blob backend without the dev proxy.

The host is a Node + Effect app. The umbrella plan already marks a spawnable host artifact as the desktop phase dependency. The exact mechanism remains open and must be decided by a packaging spike: standalone binary, bundled Node, or another sidecar packaging approach.

## 3. Phases

### Phase 1: Desktop Shell Skeleton and Shared Launcher Boundary

**Goal:** A Tauri app can open the existing web UI and reuse launcher semantics without yet packaging the host.

**Gate from previous:** Launcher/session identity behavior is understood and tested.

#### M1: Workspace and App Skeleton

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add repository/tooling tests or checks that the desktop app package is discoverable in the pnpm workspace without affecting existing web/host builds.
  2. GREEN: Add a Tauri v2 desktop app shell that loads the built web UI.
  3. RED: Add config tests for Vite desktop build base path and asset loading.
  4. GREEN: Configure desktop-safe web asset loading with `base: './'` or the Tauri asset protocol.
  5. REFACTOR: Keep desktop-specific config isolated from browser dev config.

#### M2: Shared Launcher Core

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving desktop and CLI resolve the same project root and session id for the same cwd.
  2. GREEN: Extract or expose reusable launcher/session/host-registry logic so Tauri can call the same behavior.
  3. RED: Add tests for host ownership and lock compatibility between CLI and desktop.
  4. GREEN: Define a desktop supervisor adapter over the shared launcher core.
  5. REFACTOR: Avoid duplicating project/session mapping code in Rust and TypeScript unless it is generated/shared from one source.

### Gate 1->2

- [ ] Desktop app shell launches and renders the web build.
- [ ] CLI and desktop share project/session identity behavior.
- [ ] Existing browser dev flow still works.

### Phase 2: Runtime Config and Transport Preservation

**Goal:** The desktop webview connects to session/blob backends through explicit runtime config, not dev proxy assumptions.

**Gate from previous:** Desktop shell can render the web app.

#### M3: Runtime Backend Config

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add web config tests for browser mode, desktop mode, session-store URL, Richter URL, and blob URL.
  2. GREEN: Add a runtime config path for session and blob backend origins.
  3. RED: Add tests proving the web transport uses the configured backend rather than the Vite proxy in desktop mode.
  4. GREEN: Wire desktop config injection from Tauri into the webview.
  5. REFACTOR: Keep config parsing schema-validated at the boundary.

#### M4: Tauri CSP and Capabilities

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add desktop config tests for allowed HTTP and WebSocket origins.
  2. GREEN: Configure Tauri CSP/capabilities for local session-store/Richter REST and WebSocket origins plus blob-store assets.
  3. RED: Add tests or smoke checks for blocked unknown origins.
  4. GREEN: Keep allowlist minimal and environment/runtime-specific.
  5. REFACTOR: Document the security boundary between Tauri IPC and session transport.

### Gate 2->3

- [ ] Desktop webview connects to local session-store/Richter via configured transport.
- [ ] Blob assets load in desktop mode.
- [ ] Tauri IPC is not used for transcript or tool communication.

### Phase 3: Spawnable Host and Service Supervision

**Goal:** Desktop can start/reuse the right services and one host runtime per session/cwd.

**Gate from previous:** Runtime config can point web to live services.

#### M5: Host Sidecar Packaging Spike

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add spike criteria for host artifact options: standalone binary, bundled Node, startup time, size, env handling, stack traces, Effect runtime compatibility, macOS signing compatibility.
  2. GREEN: Test at least two host sidecar packaging approaches against a minimal host boot.
  3. RED: Add smoke check proving the chosen artifact can connect to a session backend and announce `host.online`.
  4. GREEN: Record the packaging decision in plan-db and update the implementation plan if needed.
  5. REFACTOR: Remove failed spike artifacts from the repo or quarantine them under ignored temp output.

#### M6: Shared Service Supervision

- **Dependencies:** M3, M5
- **Effort:** L
- **Tasks:**
  1. RED: Add desktop supervisor tests for service states: already running, missing, port conflict, start failure, unhealthy.
  2. GREEN: Start/reuse session-store and blob-store for local desktop mode.
  3. RED: Add tests proving services remain singletons across multiple projects/sessions.
  4. GREEN: Surface service startup and failure states in desktop startup UI/Doctor.
  5. REFACTOR: Keep service lifecycle separate from session host lifecycle.

#### M7: Per-Session Host Supervision

- **Dependencies:** M2, M5, M6
- **Effort:** L
- **Tasks:**
  1. RED: Add tests for one host per session/cwd, host reuse, stale host replacement, and concurrent open locking.
  2. GREEN: Spawn/reuse the packaged host sidecar with `SESSION_ID`, `TREVOR_WORKSPACE`, backend URLs, cwd, and safe env.
  3. RED: Add tests for host restart/teardown and lease handoff behavior.
  4. GREEN: Store host ownership records under the established Trevor home/state roots.
  5. REFACTOR: Keep host supervision lifecycle out of web React state.

### Gate 3->4

- [ ] Desktop starts/reuses shared services.
- [ ] Desktop starts/reuses exactly one host per session/cwd.
- [ ] Spawned host announces and answers through the session log.

### Phase 4: Desktop Session UX

**Goal:** The desktop app manages many sessions/windows while preserving existing web/session semantics.

**Gate from previous:** Service and host supervision work.

#### M8: Desktop Session Open/Restore

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for restoring last open sessions/windows from desktop state.
  2. GREEN: Reopen last project sessions and start/reuse their hosts.
  3. RED: Add tests for creating/opening a project session from desktop UI.
  4. GREEN: Wire project/session open through the shared launcher core.
  5. REFACTOR: Keep browser URL deep links compatible with desktop session identity.

#### M9: Window and Multi-View Semantics

- **Dependencies:** M8
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for extra windows/views attaching as clients without spawning duplicate hosts.
  2. GREEN: Support one-window-many-sessions first, with optional extra view windows as lease-free clients.
  3. RED: Add tests for closing a window versus stopping a host.
  4. GREEN: Define desktop close/quit behavior: detach view, stop managed hosts, or keep services alive according to explicit policy.
  5. REFACTOR: Make lifecycle labels clear in UI and Doctor.

### Gate 4->5

- [ ] Desktop restores/open sessions without duplicate hosts.
- [ ] Closing views does not silently delete durable sessions.
- [ ] Multi-view fan-out preserves one answering host.

### Phase 5: Packaging, Signing, Updates, and E2E

**Goal:** Desktop shell is installable/testable with a repeatable packaging and smoke path.

**Gate from previous:** Desktop runtime behavior works in dev.

#### M10: Packaging and Signing

- **Dependencies:** M5, M9
- **Effort:** L
- **Tasks:**
  1. RED: Add packaging checks for macOS app bundle contents: web assets, sidecars, config, icons, entitlements, and version metadata.
  2. GREEN: Configure Tauri build for macOS first.
  3. RED: Add checks for signing/notarization inputs or documented unsigned-dev path.
  4. GREEN: Add release artifact layout and update metadata placeholders.
  5. REFACTOR: Keep desktop packaging scripts separate from web/host dev commands.

#### M11: Desktop Smoke and E2E

- **Dependencies:** M10
- **Effort:** L
- **Tasks:**
  1. RED: Add desktop smoke for booting the app, loading web UI, starting local services, and opening a session.
  2. GREEN: Verify host sidecar attach and `host.online`.
  3. RED: Add smoke for prompt turn with fake provider or hermetic provider harness.
  4. GREEN: Verify shutdown cleanup: no duplicate host, expected services, no orphaned sidecar.
  5. REFACTOR: Fold reusable desktop smoke helpers into `packages/test-kit` only where they benefit other tests.

### Gate 5

- [ ] Desktop app builds on macOS.
- [ ] Host sidecar is packaged and launches.
- [ ] Desktop smoke covers boot, host attach, prompt, restore, and shutdown cleanup.
- [ ] Browser dev flow remains unaffected.

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Host cannot package cleanly as a sidecar | high | medium | Dedicated M5 packaging spike before deep desktop wiring. | Host/Desktop |
| Tauri IPC becomes a hidden app protocol | high | medium | Tests and docs require web/host communication only through session transport. | Desktop/Web |
| Desktop duplicates launcher logic | medium | high | Extract/share pure launcher core and add compatibility tests. | CLI/Desktop |
| Port/service conflicts are confusing | medium | medium | Reuse service classification, surface conflicts in startup UI and Doctor. | Desktop |
| Signing/notarization delays packaging | medium | medium | Separate unsigned-dev package path from signed release path. | Release |
| Multi-window semantics spawn duplicate hosts | high | medium | One-host-per-session tests and explicit lease-free view contract. | Desktop/Host |

## 5. Escape Hatches

1. **If host sidecar packaging fails:** ship desktop dev shell that supervises the existing Node host command, and keep distributable packaging blocked on M5.
2. **If embedded service supervision is too much for first cut:** require shared services to be running and use desktop only for webview + host supervision, with clear Doctor/startup errors.
3. **If runtime config/CSP becomes brittle:** start with local session-store only in desktop mode and defer remote Richter desktop mode.
4. **If multi-window creates lifecycle ambiguity:** ship one-window-many-sessions first and disable extra windows until lifecycle tests are complete.

## 6. Progress Report Accounting

The progress report is `.plans/30-desktop-shell-tauri/progress-report.md`. It tracks only the desktop shell/Tauri extraction. It does not track forkable sessions, general artifact panels, or runtime feature work inside the web app except for desktop-safe config seams.

## 7. Validation Commands

```bash
pnpm --filter @trevor/web build
pnpm --filter @trevor/trevor-cli test
pnpm --filter @trevor/agent-host test
pnpm test -- --project e2e
pnpm typecheck
pnpm biome check
# later, once Tauri app exists:
pnpm --filter @trevor/desktop tauri build
pnpm --filter @trevor/desktop test
```

## 8. Decisions

Canonical decisions are in `.plans/30-desktop-shell-tauri/plan.db`.

