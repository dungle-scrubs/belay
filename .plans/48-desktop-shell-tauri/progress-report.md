# Desktop Shell Tauri - Progress Report

> Current focus: 0. Hard Dependencies

## 0. Hard Dependencies

- [x] `03-filesystem-root-taxonomy`.
- [x] Existing D-085 launcher and host registry.
- [ ] `44.1-supervisor-foundation` - M2 consumes `@trevor/launcher` instead of re-extracting the launcher core.
- [x] Existing session transport contract.
- [x] Existing local services.
- [ ] Spawnable host artifact.
- [ ] Desktop packaging decision.

## Phase 1: Desktop Shell Skeleton and Shared Launcher Boundary

### M1: Workspace and App Skeleton

- [ ] RED: Add repository/tooling tests or checks that the desktop app package is discoverable in the pnpm workspace without affecting existing web/host builds
- [ ] GREEN: Add a Tauri v2 desktop app shell that loads the built web UI
- [ ] RED: Add config tests for Vite desktop build base path and asset loading
- [ ] GREEN: Configure desktop-safe web asset loading with `base: './'` or the Tauri asset protocol
- [ ] REFACTOR: Keep desktop-specific config isolated from browser dev config

### M2: Shared Launcher Core

- [ ] RED: Add tests proving desktop and CLI resolve the same project root and session id for the same cwd (both via `@trevor/launcher`)
- [ ] GREEN: Wire the desktop core to call `@trevor/launcher` (from 44.1) so Tauri gets the same launcher/session/host-registry behavior as the CLI
- [ ] RED: Add tests for host ownership and lock compatibility between CLI and desktop
- [ ] GREEN: Define a desktop supervisor adapter over the shared launcher core
- [ ] REFACTOR: Avoid duplicating project/session mapping code in Rust and TypeScript unless it is generated/shared from one source

### Gate 1->2

- [ ] Desktop app shell launches and renders the web build
- [ ] CLI and desktop share project/session identity behavior
- [ ] Existing browser dev flow still works

## Phase 2: Runtime Config and Transport Preservation

### M3: Runtime Backend Config

- [ ] RED: Add web config tests for browser mode, desktop mode, session-store URL, Richter URL, and blob URL
- [ ] GREEN: Add a runtime config path for session and blob backend origins
- [ ] RED: Add tests proving the web transport uses the configured backend rather than the Vite proxy in desktop mode
- [ ] GREEN: Wire desktop config injection from Tauri into the webview
- [ ] REFACTOR: Keep config parsing schema-validated at the boundary

### M4: Tauri CSP and Capabilities

- [ ] RED: Add desktop config tests for allowed HTTP and WebSocket origins
- [ ] GREEN: Configure Tauri CSP/capabilities for local session-store/Richter REST and WebSocket origins plus blob-store assets
- [ ] RED: Add tests or smoke checks for blocked unknown origins
- [ ] GREEN: Keep allowlist minimal and environment/runtime-specific
- [ ] REFACTOR: Document the security boundary between Tauri IPC and session transport

### Gate 2->3

- [ ] Desktop webview connects to local session-store/Richter via configured transport
- [ ] Blob assets load in desktop mode
- [ ] Tauri IPC is not used for transcript or tool communication

## Phase 3: Spawnable Host and Service Supervision

### M5: Host Sidecar Packaging Spike

- [ ] RED: Add spike criteria for host artifact options: standalone binary, bundled Node, startup time, size, env handling, stack traces, Effect runtime compatibility, macOS signing compatibility
- [ ] GREEN: Test at least two host sidecar packaging approaches against a minimal host boot
- [ ] RED: Add smoke check proving the chosen artifact can connect to a session backend and announce `host.online`
- [ ] GREEN: Record the packaging decision in plan-db and update the implementation plan if needed
- [ ] REFACTOR: Remove failed spike artifacts from the repo or quarantine them under ignored temp output

### M6: Shared Service Supervision

- [ ] RED: Add desktop supervisor tests for service states: already running, missing, port conflict, start failure, unhealthy
- [ ] GREEN: Start/reuse session-store and blob-store for local desktop mode
- [ ] RED: Add tests proving services remain singletons across multiple projects/sessions
- [ ] GREEN: Surface service startup and failure states in desktop startup UI/Doctor
- [ ] REFACTOR: Keep service lifecycle separate from session host lifecycle

### M7: Per-Session Host Supervision

- [ ] RED: Add tests for one host per session/cwd, host reuse, stale host replacement, and concurrent open locking
- [ ] GREEN: Spawn/reuse the packaged host sidecar with `SESSION_ID`, `TREVOR_WORKSPACE`, backend URLs, cwd, and safe env
- [ ] RED: Add tests for host restart/teardown and lease handoff behavior
- [ ] GREEN: Store host ownership records under the established Trevor home/state roots
- [ ] REFACTOR: Keep host supervision lifecycle out of web React state

### Gate 3->4

- [ ] Desktop starts/reuses shared services
- [ ] Desktop starts/reuses exactly one host per session/cwd
- [ ] Spawned host announces and answers through the session log

## Phase 4: Desktop Session UX

### M8: Desktop Session Open/Restore

- [ ] RED: Add tests for restoring last open sessions/windows from desktop state
- [ ] GREEN: Reopen last project sessions and start/reuse their hosts
- [ ] RED: Add tests for creating/opening a project session from desktop UI
- [ ] GREEN: Wire project/session open through the shared launcher core
- [ ] REFACTOR: Keep browser URL deep links compatible with desktop session identity

### M9: Window and Multi-View Semantics

- [ ] RED: Add tests for extra windows/views attaching as clients without spawning duplicate hosts
- [ ] GREEN: Support one-window-many-sessions first, with optional extra view windows as lease-free clients
- [ ] RED: Add tests for closing a window versus stopping a host
- [ ] GREEN: Define desktop close/quit behavior: detach view, stop managed hosts, or keep services alive according to explicit policy
- [ ] REFACTOR: Make lifecycle labels clear in UI and Doctor

### Gate 4->5

- [ ] Desktop restores/open sessions without duplicate hosts
- [ ] Closing views does not silently delete durable sessions
- [ ] Multi-view fan-out preserves one answering host

## Phase 5: Packaging, Signing, Updates, and E2E

### M10: Packaging and Signing

- [ ] RED: Add packaging checks for macOS app bundle contents: web assets, sidecars, config, icons, entitlements, and version metadata
- [ ] GREEN: Configure Tauri build for macOS first
- [ ] RED: Add checks for signing/notarization inputs or documented unsigned-dev path
- [ ] GREEN: Add release artifact layout and update metadata placeholders
- [ ] REFACTOR: Keep desktop packaging scripts separate from web/host dev commands

### M11: Desktop Smoke and E2E

- [ ] RED: Add desktop smoke for booting the app, loading web UI, starting local services, and opening a session
- [ ] GREEN: Verify host sidecar attach and `host.online`
- [ ] RED: Add smoke for prompt turn with fake provider or hermetic provider harness
- [ ] GREEN: Verify shutdown cleanup: no duplicate host, expected services, no orphaned sidecar
- [ ] REFACTOR: Fold reusable desktop smoke helpers into `packages/test-kit` only where they benefit other tests

### Gate 5

- [ ] Desktop app builds on macOS
- [ ] Host sidecar is packaged and launches
- [ ] Desktop smoke covers boot, host attach, prompt, restore, and shutdown cleanup
- [ ] Browser dev flow remains unaffected

## Summary

- Current cutoff blockers: 74 unchecked implementation/report items.
- Accepted/deferred follow-up: none.
- Superseded/obsolete checklist debt: none.
