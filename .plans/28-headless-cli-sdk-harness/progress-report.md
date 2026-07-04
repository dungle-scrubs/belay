# Headless CLI, SDK, and Harness - Progress Report

> Current focus: Done - all milestones (M1-M11) landed

## Summary

- Current cutoff blockers: 0
- Deferred follow-up: 0
- Superseded checklist debt: 0

## Hard Dependencies

- [x] `14-capability-manifest-and-trevor-expert` complete before capability discovery/export SDK helpers (the capability-manifest builder/export surface lives in `@trevor/session`; the SDK reads it via the `/trevor-export` command over the protocol)
- [x] `.plans/trevor-v2` D-085 project launcher exists before CLI layering work
- [x] `.plans/trevor-v2` D-094 session lifecycle controls exist before lifecycle SDK/CLI semantics

## M1: Package Contract and Dependency Direction

- [x] RED: Add package-boundary tests proving CLI can depend on SDK, while SDK does not depend on CLI
- [x] GREEN: Create `packages/sdk` with exports for client construction and workflow types
- [x] RED: Add tests proving SDK imports `@trevor/session` primitives rather than duplicating event/session types
- [x] GREEN: Re-export or wrap shared protocol types intentionally
- [x] REFACTOR: Document app-vs-package boundaries

## M2: Transport and Backend Binding

- [x] RED: Add tests for binding a client to local session-store URL and Richter URL through `streamTransport(url)`
- [x] GREEN: Implement `createTrevorClient({ sessionUrl, blobUrl, identity? })`
- [x] RED: Add tests for ensure session, replay/tail connect, publish, reconnect caller responsibility, and backend error reporting
- [x] GREEN: Provide typed session operations over `SessionTransport`
- [x] REFACTOR: Keep backend selection URL-based; no `@trevor/richter` adapter package

## M3: Artifact Client

- [x] RED: Add tests for upload/download/list-or-read helpers over blob-store wire contracts
- [x] GREEN: Implement artifact helpers using existing blob protocol and `ArtifactRef` types
- [x] RED: Add tests for missing blob-store URL, upload size errors, content type, and hash/ref stability
- [x] GREEN: Return structured artifact refs and typed failures
- [x] REFACTOR: Keep artifact bytes out of session event helpers unless explicitly attached

## M4: Transcript, Inventory, and Capabilities

- [x] RED: Add tests for reading session inventory, transcript projection, host presence/status, and capability export
- [x] GREEN: Implement typed inventory/transcript/capabilities helpers
- [x] RED: Add tests proving SDK does not scrape web UI or prompt text for capabilities
- [x] GREEN: Use `14-capability-manifest-and-trevor-expert` export surfaces when available
- [x] REFACTOR: Keep raw event access available for advanced clients

## M5: Prompt, Stream, and Cancel Workflow

- [x] RED: Add tests for submitting a user prompt into an existing session and streaming correlated turn events
- [x] GREEN: Implement `prompt`, `streamTurn`, and `subscribe` style workflows over session events
- [x] RED: Add tests for cancellation semantics matching D-094 cancel, not stop/kill
- [x] GREEN: Implement cancel helper using established run/session event contract
- [x] REFACTOR: Avoid introducing hidden single-call `ask()` API as the primary design
- [x] RED: Add tests for an optional `switchModel` workflow that sends the `.plans/09.1-mid-turn-model-switch` switch control event into an active run (initiator: programmatic), and for a typed `model.switched` event projection
- [x] GREEN: Implement the optional switch-model workflow over the session event contract, parallel to `cancel`; surface `model.switched` as a typed read with raw event access as the fallback

## M6: Session Lifecycle Workflow

- [x] RED: Add tests for archive/unarchive/list/open-target semantics matching existing CLI lifecycle behavior
- [x] GREEN: Move or share pure lifecycle workflow logic so CLI and SDK cannot drift
- [x] RED: Add tests distinguishing cancel, stop, kill, archive, and unarchive
- [x] GREEN: Expose SDK lifecycle helpers where protocol-safe; leave OS signalling to CLI/local layer
- [x] REFACTOR: Keep process ownership records out of SDK core

## M7: CLI Refactor Boundary

- [x] RED: Add CLI tests proving command output and exit behavior remain stable while implementation moves behind SDK helpers
- [x] GREEN: Route suitable operations through SDK workflow functions
- [x] RED: Add tests proving launcher-only behavior stays in CLI/app layer
- [x] GREEN: Keep local orchestration in `apps/trevor-cli` or explicit Node-only local package
- [x] REFACTOR: Keep CLI formatting/spinner/exit-code code out of SDK

## M8: Headless CLI Commands

- [x] RED: Add tests for prompt, stream, cancel, transcript, artifacts upload/download, capabilities, and doctor/export commands
- [x] GREEN: Implement CLI commands over SDK workflows
- [x] RED: Add tests for JSON output mode and human-readable mode
- [x] GREEN: Support scriptable output without spinners/noise in machine modes
- [x] REFACTOR: Keep command names consistent with existing lifecycle commands

## M9: Test-Kit Relationship

- [x] RED: Add tests showing `@trevor/test-kit` can boot stores and create an SDK client against them (`packages/test-kit/test/sdk-stack.test.ts`)
- [x] GREEN: Add SDK-aware helpers to test-kit without making test-kit the SDK (`bootSdkStack` in `packages/test-kit/src/boot.ts`)
- [x] RED: Add tests proving test-kit remains test-only and can still boot stores without agent-host/web (`packages/test-kit/test/boundary.test.ts`)
- [x] GREEN: Keep ephemeral service lifecycle in test-kit/server-kit (bootStore/bootBlob own it; the helper only composes them + an SDK client)
- [x] REFACTOR: Remove duplicate transport subscription helpers when SDK provides stable equivalents (the M10 harness drives turns via the SDK's `streamTurn`, not a new subscription helper; the legacy `liveHost` is left for its existing ask-user/claude-migration e2e callers rather than churned)

## M10: Eval/Automation Harness API

- [x] RED: Add eval harness test that starts stores, starts or attaches a host when configured, submits prompt, streams events, and gathers artifacts/results (`e2e/eval-harness.test.ts`)
- [x] GREEN: Provide documented harness helpers for deterministic fake-provider and live-provider lanes (`createFakeEvalHarness` + `liveLaneStatus` in `apps/agent-host/test/support/eval-harness.ts`)
- [x] RED: Add tests for cancellation, timeout, artifact upload, and transcript capture in harness mode
- [x] GREEN: Return structured run records suitable for eval scoring (`EvalRunRecord`)
- [x] REFACTOR: Keep live-provider prerequisites gated with explicit skip reasons (`liveLaneStatus` returns `{ available, reason }`; the live-lane test skips with the reason)

## M11: Boundary and E2E Verification

- [x] RED: Add package-boundary tests for no SDK -> CLI dependency, no SDK -> web dependency, and no server-kit domain leakage (`packages/sdk/src/boundary.test.ts`)
- [x] GREEN: Fix package dependencies and exports to enforce intended graph (boundary test green; CLI depends on SDK, SDK on session only)
- [x] RED: Add E2E test for CLI prompt/stream/cancel over local session-store and blob-store (`e2e/cli-headless.test.ts`)
- [x] GREEN: Verify SDK, CLI, and test-kit all drive the same underlying session protocol (one protocol, three consumers; e2e drives the CLI headless verbs + the harness over real stores)
- [x] REFACTOR: Document public API status and what remains internal/private (`packages/sdk/AGENTS.md` "Public API status")
