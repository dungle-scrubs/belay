# MCP Client Runtime - Implementation Plan

## 0. Hard Dependencies

None.

## Architecture

<!-- D-001 --> MCP is a generalized host-owned runtime, not a tool-proxy integration. Tool proxy, if configured, is one named MCP server like GitHub, docs, browser, design, or any other server.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| <!-- D-002 --> Capabilities stay separate | MCP tools, resources, prompts, elicitation, and sampling remain distinct host concepts with different safety and prompt semantics. |
| <!-- D-003 --> No full catalog prompt dumps | Large server catalogs are discovered, searched, capped, and attributed through explicit tool results. |
| <!-- D-004 --> Secret-minimal runtime | Stdio children receive only an allowlisted environment plus explicit server env. HTTP auth and OAuth state flow through a credential-store boundary. |
| <!-- D-005 --> Qualified identity | Same-named capabilities on different servers are normal; selection uses qualified identity with server provenance. |
| <!-- D-006 --> Full e2e coverage | Every supported MCP capability must have an end-to-end test path against fixture servers before the plan is done. |

### Boundaries

<!-- D-007 --> The host owns MCP server config, lifecycle, transport, capability cache, diagnostics, tool/resource/prompt execution, elicitation mediation, sampling mediation, redaction, and prompt guidance. The browser renders host-owned read models and never scans MCP config directly.

<!-- D-008 --> MCP calls flow through Trevor's normal tool boundary: tool events, redaction, truncation, cancellation, diagnostics, and concurrency classification. Unknown external MCP tools are not considered read-only for concurrent scheduling unless explicitly classified as read-only.

### Observability

<!-- D-009 --> `/doctor`, debug info, and UI status report per-server configured/ready/auth_needed/failed/closed state, transport, redacted endpoint or command, exposure flags, capability counts, cache freshness, last checked time, and sanitized last error. Service-specific tool-proxy health belongs to service diagnostics, not a special MCP runtime category.

---

## Phases

### Phase 1: Host Registry And Transports

**Goal:** V2 can configure named MCP servers and communicate over the supported transports safely.

#### M1: Config And Registry

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for config normalization covering enabled flags, transport, endpoint or command/args, exposure flags, request timeout, auth config, duplicate names, and redacted debug output.
  2. GREEN: Implement the named MCP server registry and normalized config model.
  3. RED: Add tests proving tool-proxy is represented as an ordinary named server, not a special runtime mode.
  4. GREEN: Add optional tool-proxy server config mapping through the same registry path.
  5. REFACTOR: Keep config parsing separate from transport construction and model-facing tools.

#### M2: Stdio Transport

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add fixture-server tests for initialize, list tools, JSON-RPC error, timeout, child crash, closed connection, and malformed response.
  2. GREEN: Implement stdio process lifecycle, handshake, request/response routing, timeout draining, and shutdown cleanup.
  3. RED: Add framing tests for partial frames, multiple frames in one buffer, case-insensitive `Content-Length`, and byte-counted multibyte bodies.
  4. GREEN: Implement robust Content-Length framing.
  5. RED: Add tests proving stdio children do not inherit provider/API-key environment variables.
  6. GREEN: Use minimal allowlisted env plus explicit server env only.

#### M3: HTTP, Streamable HTTP, And SSE

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add fixture-server tests for HTTP initialize, bearer auth, `mcp-session-id` preservation, JSON-RPC error, malformed response, timeout, and closed stream.
  2. GREEN: Implement HTTP transport with auth redaction and session-id preservation.
  3. RED: Add fixture-server tests for Streamable HTTP and SSE response compatibility, including event-stream responses for requests.
  4. GREEN: Implement Streamable HTTP/SSE parsing and response routing.
  5. REFACTOR: Share request timeout, error classification, and redaction across transports.

### Gate 1 to 2

- [ ] Registry and transport unit/integration tests pass.
- [ ] No provider/API-key env inheritance in stdio fixture tests.
- [ ] HTTP auth/session behavior is covered with fixture servers.

### Phase 2: MCP Capabilities

**Goal:** Tools, resources, prompts, elicitation, and sampling are exposed as separate bounded capabilities.

#### M4: Capability Discovery And Cache

- **Dependencies:** M2, M3
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for discovering tools, resources, and prompts with server provenance, qualified names, input schemas, and duplicate names across servers.
  2. GREEN: Implement capability discovery and cache records.
  3. RED: Add tests for `refreshCapabilities(serverName)` and search over large catalogs with result caps.
  4. GREEN: Implement refresh/search without injecting full catalogs into prompts.
  5. REFACTOR: Keep cache freshness metadata available to `/doctor` without coupling doctor to transport internals.

#### M5: Tools And Resources

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for qualified MCP tool calls, argument schema handling, bounded results, redacted errors, cancellation, and ordinary Trevor tool events.
  2. GREEN: Implement MCP tool call execution through the normal tool boundary.
  3. RED: Add tests proving resources are attributable context records, not tool execution, with bounded content and provenance.
  4. GREEN: Implement resource list/read actions.
  5. REFACTOR: Keep external-service mutation risk surfaced separately from workspace mutation risk.

#### M6: Prompts, Elicitation, And Sampling

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving MCP prompts list/get as imported prompt artifacts, not Trevor slash commands.
  2. GREEN: Implement prompt list/get with provenance and bounded expansion.
  3. RED: Add tests for elicitation accept, decline, cancel, timeout, and unavailable UI/agent path.
  4. GREEN: Implement host-owned elicitation mediation.
  5. RED: Add tests proving sampling is off by default and budget-gated when enabled.
  6. GREEN: Implement sampling mediation that returns only handler output and sanitized usage.

### Gate 2 to 3

- [ ] Tool, resource, prompt, elicitation, and sampling tests pass.
- [ ] Same-named capabilities across servers require qualified identity.
- [ ] Sampling remains disabled unless explicitly enabled.

### Phase 3: Model-Facing Surface, Diagnostics, And E2E

**Goal:** Agents can use MCP intentionally, users can inspect MCP health, and every capability is proven end to end.

#### M7: Model-Facing MCP Tool Surface

- **Dependencies:** M5, M6
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for the chosen model-facing surface (`mcp` actions or `mcp_*` family) covering capability search, tool call, resource read, prompt get, and server status.
  2. GREEN: Expose MCP as MCP without `tool_proxy` naming in generic prompt guidance.
  3. RED: Add prompt guidance tests proving the model uses MCP for configured external integrations and avoids it when built-in Trevor tools are the clearer fit.
  4. GREEN: Add bounded prompt/tool guidance with qualified identity and no full-catalog dump.
  5. REFACTOR: Keep tool-proxy-specific service hints out of generic MCP guidance.

#### M8: Doctor, Debug, And UI Status

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add `/doctor` snapshot tests for configured, ready, auth-needed, failed, closed, timeout, and unconfigured server states.
  2. GREEN: Wire MCP runtime status into doctor snapshots and debug info with redacted fields.
  3. RED: Add web Storybook/tests for MCP status states using host read models.
  4. GREEN: Render MCP status in existing doctor surfaces without exposing secrets.
  5. REFACTOR: Keep service-specific tool-proxy health under service diagnostics, not the MCP runtime category.

#### M9: Full E2E Capability Suite

- **Dependencies:** M7, M8
- **Effort:** L
- **Tasks:**
  1. RED: Add hermetic e2e fixture servers for stdio, Streamable HTTP, and SSE MCP transports.
  2. GREEN: Boot host plus fixture servers and verify capability discovery/search end to end.
  3. RED: Add e2e tests for MCP tool calls, resource list/read, prompt list/get, elicitation accept/decline/cancel, sampling denied/enabled, auth-needed, timeout, crash, and reconnect/closed transport behavior.
  4. GREEN: Implement missing runtime wiring until every e2e capability path passes.
  5. RED: Add e2e tests proving tool-proxy, when configured, behaves exactly like another named MCP server.
  6. GREEN: Remove any special-case tool-proxy runtime behavior that violates the named-server abstraction.
  7. REFACTOR: Consolidate fixture-server helpers into the appropriate test support package.

### Gate 3 to Done

- [ ] Unit tests pass for registry, transports, capability cache, redaction, and model-facing actions.
- [ ] Web/doctor tests pass for MCP status rendering.
- [ ] Hermetic e2e covers every supported MCP capability: tools, resources, prompts, elicitation, sampling, server status, discovery/search, auth-needed, stdio, Streamable HTTP, SSE, timeout, crash, and tool-proxy-as-normal-server.
- [ ] No full provider/API-key environment inheritance exists for stdio children.
- [ ] No generic prompt guidance treats tool-proxy as the MCP abstraction.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| MCP stdio child receives provider secrets | high | medium | Minimal allowlisted env plus tests that probe inherited env. | agent-host |
| Large MCP catalogs bloat prompts | high | medium | Search/cap caches and expose catalogs only through explicit tool results. | agent-host |
| Tool-proxy special cases leak into generic MCP | medium | medium | Treat tool-proxy as named server in tests and e2e. | agent-host |
| Server-originated sampling causes hidden model calls | high | low | Sampling disabled by default and budget-gated with explicit handler. | agent-host |
| Transport edge cases wedge runs | high | medium | Timeouts, pending-request draining, fixture tests, and hermetic e2e for crash/close/error. | agent-host |

---

## Escape Hatches

1. **If Streamable HTTP/SSE compatibility delays the first cut:** ship stdio plus HTTP behind a capability flag, but keep the plan open and do not mark the e2e gate complete.
2. **If sampling mediation is too risky:** keep sampling disabled and return a structured unsupported result, with e2e proving it is denied safely.
3. **If browser UI work expands:** keep MCP status visible through `/doctor` first and defer richer MCP management UI.

---

## Validation Commands

```bash
pnpm test --project unit
pnpm test --project integration
pnpm test --project web
pnpm test --project e2e
pnpm typecheck
```

---

## Decisions

Canonical decisions are in `.plans/23-mcp-client-runtime/plan.db`. Key decisions referenced in this document use `<!-- D-NNN -->` markers.
