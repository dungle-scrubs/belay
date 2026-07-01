# Tool Script - Progress Report

## Summary

- **Current focus:** M2 - Threat Model and Sandbox Contract
- **Completed:** 12 / 68
- **Current cutoff blockers:** 56
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0

## 0. Hard Dependencies

- [x] Existing V1 implementation found in `/Users/kevin/dev/trevor/packages/agent-host/src/tools/tool-script-runner.ts`.
- [x] Existing V1 direct tests found in `/Users/kevin/dev/trevor/packages/agent-host/test/tools/core-tool-script.test.ts`.
- [x] Existing V1 metadata/runtime wiring found in `tools/metadata.ts`, `agent/tool-runtime.ts`, `agent/tool-execution.ts`, and `observability/otel.ts`.
- [x] Existing V1 behavior proves `tool_script` was a normal host tool with read-only TypeScript scripts, safe-read bridge, timeout/cancel/failure output, and intermediate-output summarization.
- [x] Agent Safehouse documentation reviewed as a macOS deny-first `sandbox-exec`/profile isolation candidate: https://agent-safehouse.dev/docs/overview and https://agent-safehouse.dev/docs/isolation-models.
- [x] `03-filesystem-root-taxonomy` defines approved scratch, diagnostic, and durable storage roots.
- [x] `08-tool-detail-takeover` defines the transcript-detail pattern for inspecting richer tool output.

## Current Cutoff Blockers

### Phase 1: V1 Provenance and V2 Contract

#### M1: Provenance Snapshot

- [x] RED: Add a contract/provenance test or fixture that captures V1 `tool_script` inputs, outputs, tool-call summaries, and failures.
- [x] GREEN: Document V1 behavior from `tool-script-runner.ts`, metadata, runtime normalization, boundary error tests, and observability tests.
- [x] RED: Add V2 contract tests for completed, timed out, cancelled, syntax error, runtime error, denied permission, and oversized output results.
- [x] GREEN: Define V2 input/output types, result caps, and typed failure classes.
- [x] REFACTOR: Mark V1 in-process execution as provenance only, not the V2 safety boundary.

#### M2: Threat Model and Sandbox Contract

- [ ] RED: Add tests or policy fixtures for denied filesystem, network, environment, process, import, package, and shell access.
- [ ] GREEN: Define deny-first sandbox contract and host-bridge-only authority model.
- [ ] RED: Add tests for Safehouse available, Safehouse unavailable, non-macOS fallback, and sandbox launch failure.
- [ ] GREEN: Define sandbox mode reporting and fallback behavior without weakening bridge policy.
- [ ] REFACTOR: Keep OS sandbox policy separate from host bridge permission policy.

#### Gate 1->2

- [ ] V2 contract is explicit and distinct from V1 in-process implementation.
- [ ] Threat model states what `tool_script` cannot do directly.
- [ ] Safehouse is treated as an OS isolation layer, not the sole boundary.

### Phase 2: Sandboxed Runner Process

#### M3: Child Runner Protocol

- [ ] RED: Add runner protocol tests for start, execute, bridge request, bridge response, complete, fail, cancel, and timeout messages.
- [ ] GREEN: Implement a dedicated child runner process with a minimal JSON/RPC protocol.
- [ ] RED: Add tests proving host crashes, child crashes, malformed child messages, and stderr spam are contained.
- [ ] GREEN: Implement lifecycle cleanup, stderr/stdout caps, child termination, and correlation identifiers.
- [ ] REFACTOR: Keep child runner code isolated from agent-host tool registry code.

#### M4: Safehouse / OS Sandbox Integration

- [ ] RED: Add tests for selecting Safehouse/sandbox-exec mode on macOS and fallback mode elsewhere.
- [ ] GREEN: Launch the child runner through Agent Safehouse or equivalent sandbox profile when configured and available.
- [ ] RED: Add integration tests proving direct filesystem reads/writes, network calls, env access, process spawning, and imports are denied.
- [ ] GREEN: Generate a deny-first profile with only the minimum pipes/temp access needed for the bridge.
- [ ] REFACTOR: Expose sandbox mode and policy hash in diagnostics without leaking sensitive paths.

#### Gate 2->3

- [ ] Script code never runs inside the agent-host process.
- [ ] Direct ambient access is denied or visibly unavailable.
- [ ] Runner launch, crash, cancellation, and cleanup are deterministic.

### Phase 3: Host Bridge, Toolsets, and Budgets

#### M5: Toolset Capability Matrix

- [ ] RED: Add tests for `safe_read`, `retrieval`, `docs_read`, and `media_read` toolset validation.
- [ ] GREEN: Implement named toolset validation and bridge exposure.
- [ ] RED: Add tests proving write, edit, shell, process, clipboard, archive unpack, unrestricted MCP, direct fetch, and unknown tools are denied.
- [ ] GREEN: Route allowed bridge calls through the normal host tool registry and tool metadata policy.
- [ ] REFACTOR: Keep toolset definitions centralized and inspectable.

#### M6: Budgets and Output Bounding

- [ ] RED: Add tests for timeout, cancellation, max bridge calls, max per-tool output bytes, max final JSON bytes, and max artifact bytes.
- [ ] GREEN: Enforce all budgets at the host bridge and final output boundary.
- [ ] RED: Add tests for large intermediate output summarization and no sensitive full-content leakage in summarized output.
- [ ] GREEN: Summarize large outputs as detail/artifact refs with previews and byte counts.
- [ ] REFACTOR: Make budget counters visible to transcript/detail views.

#### Gate 3->4

- [ ] Only approved toolsets are available to scripts.
- [ ] Every bridge call is counted, capped, and auditable.
- [ ] Final output and intermediate output cannot flood transcript or context.

### Phase 4: Host Tool Integration and Observability

#### M7: Tool Runtime Integration

- [ ] RED: Add host tool runtime tests for normalizing `tool_script` requests and rejecting unsafe permissions.
- [ ] GREEN: Register `tool_script` in the V2 host tool registry, metadata, provider surface, and prompt guidance.
- [ ] RED: Add loop tests for successful script, denied bridge call, timeout, cancellation, syntax error, runtime error, and child crash.
- [ ] GREEN: Emit normal tool started/progress/completed/failed events with bridge-call summaries.
- [ ] REFACTOR: Keep `tool_script` as a tool, not a workflow runner or background job.

#### M8: Observability and Detail Payloads

- [ ] RED: Add observability tests for script start, bridge call, bridge denied, finish, timeout, cancel, and failure events.
- [ ] GREEN: Add structured spans/events with script hash, sandbox mode, toolsets, budgets, and bridge-call summaries.
- [ ] RED: Add detail payload tests for source, permissions, context, sandbox mode, budget counters, bridge calls, output, and failures.
- [ ] GREEN: Store/render bounded detail payloads without exposing oversized intermediate content.
- [ ] REFACTOR: Reuse generic tool-detail primitives from `08-tool-detail-takeover`.

#### Gate 4->5

- [ ] `tool_script` is model-facing as a normal visible tool.
- [ ] Prompt guidance tells the model when to use direct tools versus `tool_script`.
- [ ] Observability and detail payloads make every script run inspectable.

### Phase 5: UI, E2E, and Guidance

#### M9: Transcript, Compact Row, and E2E

- [ ] RED: Add web fixtures/tests for completed, timed out, cancelled, denied, syntax error, runtime error, budget exhausted, and oversized output rows.
- [ ] GREEN: Render concise transcript and compact rows with status, duration, toolsets, bridge-call count, and failure class.
- [ ] RED: Add hermetic e2e for a model using `tool_script` to batch scan multiple files through `read`/`rg`.
- [ ] GREEN: Validate full tool loop, bridge calls, budget display, and detail takeover.
- [ ] REFACTOR: Add model guidance examples: use `tool_script` for repeated read-only operations across many inputs; prefer direct tools for one-off reads/searches.

#### Gate 5

- [ ] Unit, web, integration, and hermetic e2e tests pass.
- [ ] Script execution is out-of-process and deny-first where supported.
- [ ] `tool_script` remains read-only and bounded through host bridge policy.
- [ ] Users can inspect source, permissions, bridge calls, budgets, output, and failures.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.
