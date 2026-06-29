# Tool Script - Implementation Plan

## 0. Hard Dependencies

- [x] Existing V1 implementation found in `/Users/kevin/dev/trevor/packages/agent-host/src/tools/tool-script-runner.ts`.
- [x] Existing V1 direct tests found in `/Users/kevin/dev/trevor/packages/agent-host/test/tools/core-tool-script.test.ts`.
- [x] Existing V1 metadata/runtime wiring found in `tools/metadata.ts`, `agent/tool-runtime.ts`, `agent/tool-execution.ts`, and `observability/otel.ts`.
- [x] Existing V1 behavior proves `tool_script` was a normal host tool with read-only TypeScript scripts, safe-read bridge, timeout/cancel/failure output, and intermediate-output summarization.
- [x] Agent Safehouse documentation reviewed as a macOS deny-first `sandbox-exec`/profile isolation candidate: https://agent-safehouse.dev/docs/overview and https://agent-safehouse.dev/docs/isolation-models.
- [x] `03-filesystem-root-taxonomy` defines approved scratch, diagnostic, and durable storage roots.
- [x] `08-tool-detail-takeover` defines the transcript-detail pattern for inspecting richer tool output.

## 1. Architecture

`tool_script` is a normal model-facing tool for bounded read-only batch analysis. It lets the model write a short TypeScript script that orchestrates many read/retrieval tool calls through a host-provided bridge, then returns a compact structured result. It is workflow-shaped, but it is not a workflow engine, subagent, shell replacement, or hidden autonomous loop. <!-- D-001 -->

V1 already implemented the useful product shape: a TypeScript script receives `tools` and `context`, may call a `safe_read` bridge (`read`, `glob`, `rg`, `session_recall`, `source_recall`, `project_retrieve`, `code_search`, `code_index`), and returns bounded structured output. It also records bridge-call summaries and summarizes large intermediate outputs. V2 should preserve that user/model-facing shape while replacing the in-process `AsyncFunction` execution boundary with a stronger sandbox. <!-- D-002 -->

The V2 sandbox boundary should be layered:

1. run the script in a dedicated child process, never inside the agent-host process;
2. deny direct filesystem, network, environment, process, module import, package install, shell, and native-code access;
3. on macOS, launch the child through Agent Safehouse or an equivalent `sandbox-exec` profile when available;
4. expose power only through a host RPC bridge with named toolsets, budgets, cancellation, and audit logs;
5. treat Agent Safehouse as blast-radius reduction, not the only safety control. <!-- D-003 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Normal tool | The model calls `tool_script` visibly like other tools; output appears in transcript and detail view. |
| Read-only first | First cut allows only read/retrieval/media-inspection capabilities, never mutation or shell/process execution. |
| Child process boundary | User code never runs inside the agent-host process. |
| OS sandbox where available | Agent Safehouse/`sandbox-exec` denies direct ambient filesystem/network/process access on macOS. |
| Host bridge is authoritative | All useful work goes through Trevor-owned RPC calls that enforce tool metadata, budgets, and policy. |
| Powerful but bounded | Toolsets can grow, but each call is counted, timed, capped, and visible. |
| No hidden autonomy | The script cannot keep looping forever, spawn agents, or make unbounded plans; it is a bounded computation kernel. |
| Result/detail visibility | Script source, permissions, bridge calls, budgets, failures, and output summaries are inspectable. |

### Toolset Direction

Start with named toolsets so power can grow without turning the sandbox into ambient access:

| Toolset | Initial Tools | Notes |
|---------|---------------|-------|
| `safe_read` | `read`, `glob`, `rg`, `ast_grep` | Workspace-confined read/search. |
| `retrieval` | `session_recall`, `source_recall`, `code_search`, `project_retrieve`, index status tools where available | Conceptual lookup through host policy. |
| `docs_read` | docs/web-fetch style read-only tools when their own policies permit | No raw `fetch`; network stays host-mediated. |
| `media_read` | `archive_read`, `video_inspect` after those plans land | Read-only media inspection only. |

Explicitly excluded from the first cut: `write`, `edit`, `bash`, `process`, `clipboard_write`, `archive_unpack`, unrestricted `tool_proxy`, arbitrary MCP calls, package installation, direct network access, and direct filesystem writes.

### Boundaries

- `apps/agent-host` owns tool schema, permission/toolset validation, child process lifecycle, sandbox profile selection, bridge RPC, budgets, cancellation, output shaping, and observability.
- The script runner child owns only execution of a small TypeScript/JavaScript program against the bridge protocol. It has no ambient Trevor authority.
- `packages/session` owns any protocol/read-model additions for script source, budget events, bridge-call summaries, and detail payloads.
- `apps/web` owns transcript rows, compact rows, detail takeover, and budget/error display.
- Agent Safehouse is an optional macOS OS-policy layer. Trevor must still enforce bridge permissions and budgets if Safehouse is unavailable or not applicable.

### Observability

`tool_script` is powerful enough that observability is part of the safety boundary:

- spans include script hash, language, permission toolsets, timeout, call budget, output budget, sandbox mode, child pid, and duration;
- each bridge call logs tool name, input hash, output summary size, status, duration, and failure class;
- failures are typed as validation, sandbox launch, timeout, cancellation, bridge denied, bridge failed, syntax error, runtime error, output too large, and budget exhausted;
- transcript rows show script status, toolset names, call counts, duration, and failure class;
- detail view shows script source, context, sandbox mode, bridge call list, budget counters, and truncated output/artifacts.

## 2. Current State

The V2 umbrella plan carries H-118 as `tool_script`, described as "sandboxed read-only TS scripting with a tool bridge." This plan extracts that backlog item.

V1 has a real implementation. `tool-script-runner.ts` executes compact TypeScript scripts through an in-process async function, injects `tools` and `context`, shadows `process`, `Bun`, `require`, and `fetch` as undefined, validates `permissions.toolsets`, allows only `safe_read`, records bridge-call summaries, summarizes large intermediate outputs as artifact refs, and returns stable timeout/cancel/runtime/syntax failure shapes.

V1 is useful but not a strong sandbox boundary because user-authored script code runs in-process. V2 should preserve the product shape and test coverage while moving execution out of process and layering OS sandboxing plus bridge-level policy.

## 3. Phases

### Phase 1: V1 Provenance and Threat Model

**Goal:** Define the V2 contract and security posture before implementation starts.

**Gate from previous:** H-118 has been extracted from the umbrella plan.

#### M1: Provenance Snapshot

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a contract/provenance test or fixture that captures V1 `tool_script` inputs, outputs, tool-call summaries, and failures.
  2. GREEN: Document V1 behavior from `tool-script-runner.ts`, metadata, runtime normalization, boundary error tests, and observability tests.
  3. RED: Add V2 contract tests for completed, timed out, cancelled, syntax error, runtime error, denied permission, and oversized output results.
  4. GREEN: Define V2 input/output types, result caps, and typed failure classes.
  5. REFACTOR: Mark V1 in-process execution as provenance only, not the V2 safety boundary.

#### M2: Threat Model and Sandbox Contract

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add tests or policy fixtures for denied filesystem, network, environment, process, import, package, and shell access.
  2. GREEN: Define deny-first sandbox contract and host-bridge-only authority model.
  3. RED: Add tests for Safehouse available, Safehouse unavailable, non-macOS fallback, and sandbox launch failure.
  4. GREEN: Define sandbox mode reporting and fallback behavior without weakening bridge policy.
  5. REFACTOR: Keep OS sandbox policy separate from host bridge permission policy.

### Gate 1->2

- [ ] V2 contract is explicit and distinct from V1 in-process implementation.
- [ ] Threat model states what `tool_script` cannot do directly.
- [ ] Safehouse is treated as an OS isolation layer, not the sole boundary.

### Phase 2: Sandboxed Runner Process

**Goal:** Scripts execute outside the agent-host process under a deny-first execution profile.

**Gate from previous:** Sandbox contract is defined.

#### M3: Child Runner Protocol

- **Dependencies:** M2
- **Effort:** L
- **Tasks:**
  1. RED: Add runner protocol tests for start, execute, bridge request, bridge response, complete, fail, cancel, and timeout messages.
  2. GREEN: Implement a dedicated child runner process with a minimal JSON/RPC protocol.
  3. RED: Add tests proving host crashes, child crashes, malformed child messages, and stderr spam are contained.
  4. GREEN: Implement lifecycle cleanup, stderr/stdout caps, child termination, and correlation identifiers.
  5. REFACTOR: Keep child runner code isolated from agent-host tool registry code.

#### M4: Safehouse / OS Sandbox Integration

- **Dependencies:** M3
- **Effort:** L
- **Tasks:**
  1. RED: Add tests for selecting Safehouse/sandbox-exec mode on macOS and fallback mode elsewhere.
  2. GREEN: Launch the child runner through Agent Safehouse or equivalent sandbox profile when configured and available.
  3. RED: Add integration tests proving direct filesystem reads/writes, network calls, env access, process spawning, and imports are denied.
  4. GREEN: Generate a deny-first profile with only the minimum pipes/temp access needed for the bridge.
  5. REFACTOR: Expose sandbox mode and policy hash in diagnostics without leaking sensitive paths.

### Gate 2->3

- [ ] Script code never runs inside the agent-host process.
- [ ] Direct ambient access is denied or visibly unavailable.
- [ ] Runner launch, crash, cancellation, and cleanup are deterministic.

### Phase 3: Host Bridge, Toolsets, and Budgets

**Goal:** Scripts are powerful through explicit host-mediated capabilities and bounded by policy.

**Gate from previous:** Child execution and sandbox mode are reliable.

#### M5: Toolset Capability Matrix

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for `safe_read`, `retrieval`, `docs_read`, and `media_read` toolset validation.
  2. GREEN: Implement named toolset validation and bridge exposure.
  3. RED: Add tests proving write, edit, shell, process, clipboard, archive unpack, unrestricted MCP, direct fetch, and unknown tools are denied.
  4. GREEN: Route allowed bridge calls through the normal host tool registry and tool metadata policy.
  5. REFACTOR: Keep toolset definitions centralized and inspectable.

#### M6: Budgets and Output Bounding

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for timeout, cancellation, max bridge calls, max per-tool output bytes, max final JSON bytes, and max artifact bytes.
  2. GREEN: Enforce all budgets at the host bridge and final output boundary.
  3. RED: Add tests for large intermediate output summarization and no sensitive full-content leakage in summarized output.
  4. GREEN: Summarize large outputs as detail/artifact refs with previews and byte counts.
  5. REFACTOR: Make budget counters visible to transcript/detail views.

### Gate 3->4

- [ ] Only approved toolsets are available to scripts.
- [ ] Every bridge call is counted, capped, and auditable.
- [ ] Final output and intermediate output cannot flood transcript or context.

### Phase 4: Host Tool Integration and Observability

**Goal:** `tool_script` is a normal visible V2 tool with inspectable execution details.

**Gate from previous:** Runner and bridge are safe enough for model-facing exposure.

#### M7: Tool Runtime Integration

- **Dependencies:** M5, M6
- **Effort:** L
- **Tasks:**
  1. RED: Add host tool runtime tests for normalizing `tool_script` requests and rejecting unsafe permissions.
  2. GREEN: Register `tool_script` in the V2 host tool registry, metadata, provider surface, and prompt guidance.
  3. RED: Add loop tests for successful script, denied bridge call, timeout, cancellation, syntax error, runtime error, and child crash.
  4. GREEN: Emit normal tool started/progress/completed/failed events with bridge-call summaries.
  5. REFACTOR: Keep `tool_script` as a tool, not a workflow runner or background job.

#### M8: Observability and Detail Payloads

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: Add observability tests for script start, bridge call, bridge denied, finish, timeout, cancel, and failure events.
  2. GREEN: Add structured spans/events with script hash, sandbox mode, toolsets, budgets, and bridge-call summaries.
  3. RED: Add detail payload tests for source, permissions, context, sandbox mode, budget counters, bridge calls, output, and failures.
  4. GREEN: Store/render bounded detail payloads without exposing oversized intermediate content.
  5. REFACTOR: Reuse generic tool-detail primitives from `08-tool-detail-takeover`.

### Gate 4->5

- [ ] `tool_script` is model-facing as a normal visible tool.
- [ ] Prompt guidance tells the model when to use direct tools versus `tool_script`.
- [ ] Observability and detail payloads make every script run inspectable.

### Phase 5: UI, E2E, and Guidance

**Goal:** Users can understand and trust script runs, and the model uses them only for bounded batch analysis.

**Gate from previous:** Host emits complete script events and detail payloads.

#### M9: Transcript, Compact Row, and E2E

- **Dependencies:** M7, M8, `08-tool-detail-takeover`
- **Effort:** L
- **Tasks:**
  1. RED: Add web fixtures/tests for completed, timed out, cancelled, denied, syntax error, runtime error, budget exhausted, and oversized output rows.
  2. GREEN: Render concise transcript and compact rows with status, duration, toolsets, bridge-call count, and failure class.
  3. RED: Add hermetic e2e for a model using `tool_script` to batch scan multiple files through `read`/`rg`.
  4. GREEN: Validate full tool loop, bridge calls, budget display, and detail takeover.
  5. REFACTOR: Add model guidance examples: use `tool_script` for repeated read-only operations across many inputs; prefer direct tools for one-off reads/searches.

### Gate 5

- [ ] Unit, web, integration, and hermetic e2e tests pass.
- [ ] Script execution is out-of-process and deny-first where supported.
- [ ] `tool_script` remains read-only and bounded through host bridge policy.
- [ ] Users can inspect source, permissions, bridge calls, budgets, output, and failures.

## 4. Validation Matrix

| Scenario | Expected |
|----------|----------|
| Batch read/search | Script calls allowed bridge tools and returns compact structured output. |
| Direct filesystem access | Denied by runner/sandbox; only host bridge can read. |
| Direct network/fetch | Denied; network access only through approved host tools. |
| Import/require/process/env | Denied or unavailable in runner. |
| Unsafe toolset | Request rejected before execution. |
| Bridge budget exhausted | Script stops with typed budget failure and visible counters. |
| Timeout/cancel | Child runner terminates and returns stable retryable output. |
| Large intermediate output | Summarized as artifact/detail ref, not dumped into transcript/context. |
| Detail takeover | Script source, sandbox mode, calls, budgets, and output are inspectable. |

## 5. Non-Goals

- Write/edit capability in the first cut.
- Shell/process execution from scripts.
- Arbitrary MCP access or raw `tool_proxy`.
- Package installation or module imports.
- Replacing subagents, workflows, or long-running background jobs.
- Treating Agent Safehouse as a VM-grade security guarantee.

