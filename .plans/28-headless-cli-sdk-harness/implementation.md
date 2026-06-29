# Headless CLI, SDK, and Harness - Implementation Plan

## 0. Hard Dependencies

- [ ] `14-capability-manifest-and-trevor-expert` - headless clients need capability discovery/export instead of hardcoded assumptions.
- [x] `.plans/trevor-v2` D-085 project launcher - the CLI already owns local project launch/open behavior.
- [x] `.plans/trevor-v2` D-094 session lifecycle controls - CLI/SDK lifecycle semantics must reuse cancel/stop/kill/archive definitions.

## 1. Architecture

Trevor is already headless-capable at the protocol layer: `@trevor/session` owns the typed event contract and `streamTransport(url)`, and both local `apps/session-store` and remote Richter speak the same `/sessions` REST + WebSocket contract. What is missing is a productized non-web access layer for automation, scripts, tests, evals, and other TypeScript consumers.

This plan introduces a likely new package, `@trevor/sdk`, as the ergonomic workflow layer above `@trevor/session`. The SDK should not shell out to the CLI. The CLI should call SDK workflows where they fit, while retaining local process orchestration responsibilities such as starting services, spawning/reusing hosts, opening the browser, and signalling host processes.

### Layering

```text
packages/session
  protocol primitives: SessionTransport, events, decoders, streamTransport(url), blob wire types

packages/sdk
  ergonomic workflows: prompt, stream turn, cancel, transcript, artifacts, capabilities, inventory

apps/trevor-cli
  executable terminal product: arg parsing, stdout/stderr, launcher, local services, host process lifecycle

apps/web
  rich interactive UI: transcript, artifact panel, model chooser, sidebars, command surfaces

packages/test-kit
  hermetic test harness: boot real session-store/blob-store on ephemeral ports

packages/server-kit
  server plumbing only: HTTP helpers and listen/close lifecycle for local services
```

### Key Constraints

| Constraint | Impact |
|---|---|
| SDK does not run CLI | `@trevor/sdk` talks to session-store/Richter/blob-store through protocols, not shell commands. |
| CLI remains an app | `apps/trevor-cli` owns terminal UX, local service readiness, process spawning, browser open, signals, and exit codes. |
| `@trevor/session` stays low-level | Do not turn the protocol package into a high-level workflow SDK. |
| Web remains rich UI | SDK/CLI expose data and operations, not duplicate visual surfaces like artifact panel or model chooser. |
| Local process orchestration is Node-only | Starting services/spawning hosts is not part of browser-safe SDK core. |
| No revival of dropped `SDK ask()` shortcut | Headless prompting is session/workflow oriented, not a hidden single-prompt routing API. |

### Boundaries

- **SDK core:** `createTrevorClient({ sessionUrl, blobUrl })`, session transport binding, artifact client, typed event helpers, transcript/inventory/capability reads.
- **SDK workflow layer:** prompt submission, stream assistant/turn events, cancel active run, upload/download artifacts, read transcript, inspect tasks/status.
- **Optional local Node layer:** launch/attach helpers may wrap CLI launcher internals or a shared local orchestration package, but must be separate from browser-safe SDK core.
- **CLI:** maps command-line verbs to SDK workflows and local orchestration; formats terminal output; handles exit codes and spinners.
- **Harness:** `@trevor/test-kit` remains test infrastructure; it can reuse SDK primitives once stable but should not become the public SDK.

### Observability

- SDK workflows return structured errors with operation, session id, backend URL class, and redacted details.
- CLI maps structured SDK errors to concise terminal output and nonzero exit codes.
- SDK can expose debug hooks/events for tests/evals without logging prompts, artifact bytes, auth headers, or raw provider payloads by default.

## 2. Phases

### Phase 1: SDK Package Boundary

**Goal:** Establish `@trevor/sdk` as an ergonomic package above `@trevor/session`.

**Gate from previous:** `@trevor/session` transport and D-094 lifecycle semantics exist.

#### M1: Package Contract and Dependency Direction

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add package-boundary tests or static checks proving CLI can depend on SDK, while SDK does not depend on CLI.
  2. GREEN: Create `packages/sdk` with exports for client construction and workflow types.
  3. RED: Add tests proving SDK imports `@trevor/session` primitives rather than duplicating event/session types.
  4. GREEN: Re-export or wrap shared protocol types intentionally.
  5. REFACTOR: Document app-vs-package boundaries in the package README or AGENTS guidance.

#### M2: Transport and Backend Binding

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for binding a client to local session-store URL and Richter URL through `streamTransport(url)`.
  2. GREEN: Implement `createTrevorClient({ sessionUrl, blobUrl, identity? })`.
  3. RED: Add tests for ensure session, connect replay/tail, publish, reconnect caller responsibility, and backend error reporting.
  4. GREEN: Provide typed session operations over `SessionTransport`.
  5. REFACTOR: Keep backend selection URL-based; no `@trevor/richter` adapter package.

#### M3: Artifact Client

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for upload/download/list-or-read helpers over blob-store wire contracts.
  2. GREEN: Implement artifact helpers using existing blob protocol and `ArtifactRef` types.
  3. RED: Add tests for missing blob-store URL, upload size errors, content type, and hash/ref stability.
  4. GREEN: Return structured artifact refs and typed failures.
  5. REFACTOR: Keep artifact bytes out of session event helpers unless explicitly attached.

### Phase 2: Headless Workflows

**Goal:** SDK exposes useful Trevor workflows without recreating web UI.

**Gate from previous:** SDK can bind to session and blob backends.

#### M4: Transcript, Inventory, and Capabilities

- **Dependencies:** M1-M3, `14-capability-manifest-and-trevor-expert`
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for reading session inventory, transcript projection, host presence/status, and capability export.
  2. GREEN: Implement typed inventory/transcript/capabilities helpers.
  3. RED: Add tests proving SDK does not scrape web UI or prompt text for capabilities.
  4. GREEN: Use `14-capability-manifest-and-trevor-expert` export surfaces when available.
  5. REFACTOR: Keep raw event access available for advanced clients.

#### M5: Prompt, Stream, and Cancel Workflow

- **Dependencies:** M1-M4
- **Effort:** L
- **Tasks:**
  1. RED: Add tests for submitting a user prompt into an existing session and streaming correlated turn events.
  2. GREEN: Implement `prompt`, `streamTurn`, and `subscribe` style workflows over session events.
  3. RED: Add tests for cancellation semantics matching D-094 cancel, not stop/kill.
  4. GREEN: Implement cancel helper using the established run/session event contract.
  5. REFACTOR: Avoid introducing a hidden single-call `ask()` API as the primary design.

#### M6: Session Lifecycle Workflow

- **Dependencies:** M4, `.plans/trevor-v2` D-094
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for archive/unarchive/list/open-target semantics matching existing CLI lifecycle behavior.
  2. GREEN: Move or share pure lifecycle workflow logic so CLI and SDK cannot drift.
  3. RED: Add tests distinguishing cancel, stop, kill, archive, and unarchive.
  4. GREEN: Expose SDK lifecycle helpers where they are protocol-safe; leave OS signalling to CLI/local layer.
  5. REFACTOR: Keep process ownership records out of SDK core.

### Phase 3: CLI Over SDK

**Goal:** CLI uses SDK workflows where appropriate while retaining app-only local orchestration.

**Gate from previous:** SDK workflows cover session/artifact/capability operations.

#### M7: CLI Refactor Boundary

- **Dependencies:** M1-M6
- **Effort:** M
- **Tasks:**
  1. RED: Add CLI tests proving command output and exit behavior remain stable while implementation moves behind SDK helpers.
  2. GREEN: Route list/archive/unarchive/open-target/artifact/capability operations through SDK workflow functions where sensible.
  3. RED: Add tests proving launcher-only behavior stays in CLI/app layer: service readiness, host spawn/reuse, browser open, process signals.
  4. GREEN: Keep local orchestration in `apps/trevor-cli` or an explicitly Node-only local package.
  5. REFACTOR: Keep CLI formatting/spinner/exit-code code out of SDK.

#### M8: Headless CLI Commands

- **Dependencies:** M7
- **Effort:** L
- **Tasks:**
  1. RED: Add tests for headless commands: prompt, stream, cancel, transcript, artifacts upload/download, capabilities, and doctor/export where available.
  2. GREEN: Implement CLI commands over SDK workflows.
  3. RED: Add tests for JSON output mode and human-readable mode.
  4. GREEN: Support scriptable output without spinners/noise in machine modes.
  5. REFACTOR: Keep command names consistent with existing `trevor list/open/archive/stop/kill`.

### Phase 4: Harness and Evals

**Goal:** Test/eval harnesses can drive Trevor through stable APIs without depending on product UI.

**Gate from previous:** SDK workflow layer is stable.

#### M9: Test-Kit Relationship

- **Dependencies:** M1-M8
- **Effort:** M
- **Tasks:**
  1. RED: Add tests showing `@trevor/test-kit` can boot real session-store/blob-store and create an SDK client against them.
  2. GREEN: Add SDK-aware helpers to test-kit without making test-kit the SDK.
  3. RED: Add tests proving test-kit remains test-only and can still boot stores without agent-host/web.
  4. GREEN: Keep ephemeral service lifecycle in test-kit/server-kit.
  5. REFACTOR: Remove duplicate transport subscription helpers when SDK provides stable equivalents.

#### M10: Eval/Automation Harness API

- **Dependencies:** M9
- **Effort:** M
- **Tasks:**
  1. RED: Add an eval harness test that starts stores, starts or attaches a host when configured, submits a prompt, streams events, and gathers artifacts/results.
  2. GREEN: Provide documented harness helpers for deterministic fake-provider and live-provider lanes.
  3. RED: Add tests for cancellation, timeout, artifact upload, and transcript capture in harness mode.
  4. GREEN: Return structured run records suitable for eval scoring.
  5. REFACTOR: Keep live-provider prerequisites gated with explicit skip reasons.

### Phase 5: Verification

**Goal:** CLI, SDK, and harness boundaries are clear, tested, and usable.

**Gate from previous:** M1-M10 pass.

#### M11: Boundary and E2E Verification

- **Dependencies:** M1-M10
- **Effort:** M
- **Tasks:**
  1. RED: Add package-boundary tests for no SDK -> CLI dependency, no SDK -> web dependency, and no server-kit domain leakage.
  2. GREEN: Fix package dependencies and exports to enforce the intended graph.
  3. RED: Add E2E test for CLI prompt/stream/cancel over local session-store and blob-store.
  4. GREEN: Verify SDK, CLI, and test-kit all drive the same underlying session protocol.
  5. REFACTOR: Document public API status and what remains internal/private.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---:|---:|---|---|
| SDK becomes a second protocol package | high | medium | Require SDK to import `@trevor/session` and add type drift tests. | SDK |
| CLI orchestration leaks into SDK core | high | medium | Split browser-safe SDK core from optional Node-only local orchestration. | CLI/SDK |
| SDK revives dropped `ask()` shortcut | high | medium | Make prompt/stream session-oriented; do not ship `ask()` as the primary API. | SDK |
| Web and SDK workflow helpers diverge | medium | medium | Share protocol helpers but keep rich UI behavior web-owned. | Web/SDK |
| Test-kit becomes public product SDK | medium | medium | Keep test-kit focused on ephemeral boot and test helpers; SDK owns workflows. | Test |

## 4. Escape Hatches

1. **If `@trevor/sdk` is too early:** first extract reusable workflow functions from CLI into a private package, then promote once stable.
2. **If local orchestration needs SDK access:** add a separate Node-only subpath or package, not the browser-safe SDK core.
3. **If prompt workflow semantics are unclear:** ship read-only SDK first: inventory, transcript, capabilities, artifacts, raw subscribe.

## 5. Progress Report Accounting

The progress report is `.plans/28-headless-cli-sdk-harness/progress-report.md`. It tracks the productized headless access layer: SDK package, CLI-over-SDK workflows, and harness/eval usage. It does not move web UI features, `server-kit`, or `test-kit` beyond their intended roles except where they integrate with SDK helpers.

Before implementation resumes, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "28-headless-cli-sdk-harness"
```

## 6. Validation Commands

```bash
pnpm test
pnpm --filter @trevor/session typecheck
pnpm --filter @trevor/cli typecheck
pnpm --filter @trevor/test-kit typecheck
pnpm typecheck
```

## 7. Decisions

Canonical decisions are in `.plans/28-headless-cli-sdk-harness/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "28-headless-cli-sdk-harness"
```
