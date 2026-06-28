# Headless CLI, SDK, and Harness - Progress Report

> Current focus: Hard Dependencies

## Summary

- Current cutoff blockers: 56
- Deferred follow-up: 0
- Superseded checklist debt: 0

## Hard Dependencies

- [ ] `19-capability-manifest-and-trevor-expert` complete before capability discovery/export SDK helpers
- [x] `.plans/trevor-v2` D-085 project launcher exists before CLI layering work
- [x] `.plans/trevor-v2` D-094 session lifecycle controls exist before lifecycle SDK/CLI semantics

## M1: Package Contract and Dependency Direction

- [ ] RED: Add package-boundary tests proving CLI can depend on SDK, while SDK does not depend on CLI
- [ ] GREEN: Create `packages/sdk` with exports for client construction and workflow types
- [ ] RED: Add tests proving SDK imports `@trevor/session` primitives rather than duplicating event/session types
- [ ] GREEN: Re-export or wrap shared protocol types intentionally
- [ ] REFACTOR: Document app-vs-package boundaries

## M2: Transport and Backend Binding

- [ ] RED: Add tests for binding a client to local session-store URL and Richter URL through `streamTransport(url)`
- [ ] GREEN: Implement `createTrevorClient({ sessionUrl, blobUrl, identity? })`
- [ ] RED: Add tests for ensure session, replay/tail connect, publish, reconnect caller responsibility, and backend error reporting
- [ ] GREEN: Provide typed session operations over `SessionTransport`
- [ ] REFACTOR: Keep backend selection URL-based; no `@trevor/richter` adapter package

## M3: Artifact Client

- [ ] RED: Add tests for upload/download/list-or-read helpers over blob-store wire contracts
- [ ] GREEN: Implement artifact helpers using existing blob protocol and `ArtifactRef` types
- [ ] RED: Add tests for missing blob-store URL, upload size errors, content type, and hash/ref stability
- [ ] GREEN: Return structured artifact refs and typed failures
- [ ] REFACTOR: Keep artifact bytes out of session event helpers unless explicitly attached

## M4: Transcript, Inventory, and Capabilities

- [ ] RED: Add tests for reading session inventory, transcript projection, host presence/status, and capability export
- [ ] GREEN: Implement typed inventory/transcript/capabilities helpers
- [ ] RED: Add tests proving SDK does not scrape web UI or prompt text for capabilities
- [ ] GREEN: Use `19-capability-manifest-and-trevor-expert` export surfaces when available
- [ ] REFACTOR: Keep raw event access available for advanced clients

## M5: Prompt, Stream, and Cancel Workflow

- [ ] RED: Add tests for submitting a user prompt into an existing session and streaming correlated turn events
- [ ] GREEN: Implement `prompt`, `streamTurn`, and `subscribe` style workflows over session events
- [ ] RED: Add tests for cancellation semantics matching D-094 cancel, not stop/kill
- [ ] GREEN: Implement cancel helper using established run/session event contract
- [ ] REFACTOR: Avoid introducing hidden single-call `ask()` API as the primary design

## M6: Session Lifecycle Workflow

- [ ] RED: Add tests for archive/unarchive/list/open-target semantics matching existing CLI lifecycle behavior
- [ ] GREEN: Move or share pure lifecycle workflow logic so CLI and SDK cannot drift
- [ ] RED: Add tests distinguishing cancel, stop, kill, archive, and unarchive
- [ ] GREEN: Expose SDK lifecycle helpers where protocol-safe; leave OS signalling to CLI/local layer
- [ ] REFACTOR: Keep process ownership records out of SDK core

## M7: CLI Refactor Boundary

- [ ] RED: Add CLI tests proving command output and exit behavior remain stable while implementation moves behind SDK helpers
- [ ] GREEN: Route suitable operations through SDK workflow functions
- [ ] RED: Add tests proving launcher-only behavior stays in CLI/app layer
- [ ] GREEN: Keep local orchestration in `apps/trevor-cli` or explicit Node-only local package
- [ ] REFACTOR: Keep CLI formatting/spinner/exit-code code out of SDK

## M8: Headless CLI Commands

- [ ] RED: Add tests for prompt, stream, cancel, transcript, artifacts upload/download, capabilities, and doctor/export commands
- [ ] GREEN: Implement CLI commands over SDK workflows
- [ ] RED: Add tests for JSON output mode and human-readable mode
- [ ] GREEN: Support scriptable output without spinners/noise in machine modes
- [ ] REFACTOR: Keep command names consistent with existing lifecycle commands

## M9: Test-Kit Relationship

- [ ] RED: Add tests showing `@trevor/test-kit` can boot stores and create an SDK client against them
- [ ] GREEN: Add SDK-aware helpers to test-kit without making test-kit the SDK
- [ ] RED: Add tests proving test-kit remains test-only and can still boot stores without agent-host/web
- [ ] GREEN: Keep ephemeral service lifecycle in test-kit/server-kit
- [ ] REFACTOR: Remove duplicate transport subscription helpers when SDK provides stable equivalents

## M10: Eval/Automation Harness API

- [ ] RED: Add eval harness test that starts stores, starts or attaches a host when configured, submits prompt, streams events, and gathers artifacts/results
- [ ] GREEN: Provide documented harness helpers for deterministic fake-provider and live-provider lanes
- [ ] RED: Add tests for cancellation, timeout, artifact upload, and transcript capture in harness mode
- [ ] GREEN: Return structured run records suitable for eval scoring
- [ ] REFACTOR: Keep live-provider prerequisites gated with explicit skip reasons

## M11: Boundary and E2E Verification

- [ ] RED: Add package-boundary tests for no SDK -> CLI dependency, no SDK -> web dependency, and no server-kit domain leakage
- [ ] GREEN: Fix package dependencies and exports to enforce intended graph
- [ ] RED: Add E2E test for CLI prompt/stream/cancel over local session-store and blob-store
- [ ] GREEN: Verify SDK, CLI, and test-kit all drive the same underlying session protocol
- [ ] REFACTOR: Document public API status and what remains internal/private
