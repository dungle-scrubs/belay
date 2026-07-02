# MCP Client Runtime - Progress Report

## Summary

> Current focus: complete - all milestones done

- Current cutoff blockers: 0 unchecked
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0

## Current Cutoff

### M1: Config And Registry

- [x] RED: Add tests for config normalization covering enabled flags, transport, endpoint or command/args, exposure flags, request timeout, auth config, duplicate names, and redacted debug output.
- [x] GREEN: Implement the named MCP server registry and normalized config model.
- [x] RED: Add tests proving tool-proxy is represented as an ordinary named server, not a special runtime mode.
- [x] GREEN: Add optional tool-proxy server config mapping through the same registry path.
- [x] REFACTOR: Keep config parsing separate from transport construction and model-facing tools.

### M2: Stdio Transport

- [x] RED: Add fixture-server tests for initialize, list tools, JSON-RPC error, timeout, child crash, closed connection, and malformed response.
- [x] GREEN: Implement stdio process lifecycle, handshake, request/response routing, timeout draining, and shutdown cleanup.
- [x] RED: Add framing tests for partial frames, multiple frames in one buffer, case-insensitive `Content-Length`, and byte-counted multibyte bodies.
- [x] GREEN: Implement robust Content-Length framing.
- [x] RED: Add tests proving stdio children do not inherit provider/API-key environment variables.
- [x] GREEN: Use minimal allowlisted env plus explicit server env only.

### M3: HTTP, Streamable HTTP, And SSE

- [x] RED: Add fixture-server tests for HTTP initialize, bearer auth, `mcp-session-id` preservation, JSON-RPC error, malformed response, timeout, and closed stream.
- [x] GREEN: Implement HTTP transport with auth redaction and session-id preservation.
- [x] RED: Add fixture-server tests for Streamable HTTP and SSE response compatibility, including event-stream responses for requests.
- [x] GREEN: Implement Streamable HTTP/SSE parsing and response routing.
- [x] REFACTOR: Share request timeout, error classification, and redaction across transports.

### Gate 1 to 2

- [x] Registry and transport unit/integration tests pass.
- [x] No provider/API-key env inheritance in stdio fixture tests.
- [x] HTTP auth/session behavior is covered with fixture servers.

### M4: Capability Discovery And Cache

- [x] RED: Add tests for discovering tools, resources, and prompts with server provenance, qualified names, input schemas, and duplicate names across servers.
- [x] GREEN: Implement capability discovery and cache records.
- [x] RED: Add tests for `refreshCapabilities(serverName)` and search over large catalogs with result caps.
- [x] GREEN: Implement refresh/search without injecting full catalogs into prompts.
- [x] REFACTOR: Keep cache freshness metadata available to `/doctor` without coupling doctor to transport internals.

### M5: Tools And Resources

- [x] RED: Add tests for qualified MCP tool calls, argument schema handling, bounded results, redacted errors, cancellation, and ordinary Trevor tool events.
- [x] GREEN: Implement MCP tool call execution through the normal tool boundary.
- [x] RED: Add tests proving resources are attributable context records, not tool execution, with bounded content and provenance.
- [x] GREEN: Implement resource list/read actions.
- [x] REFACTOR: Keep external-service mutation risk surfaced separately from workspace mutation risk.

### M6: Prompts, Elicitation, And Sampling

- [x] RED: Add tests proving MCP prompts list/get as imported prompt artifacts, not Trevor slash commands.
- [x] GREEN: Implement prompt list/get with provenance and bounded expansion.
- [x] RED: Add tests for elicitation accept, decline, cancel, timeout, and unavailable UI/agent path.
- [x] GREEN: Implement host-owned elicitation mediation.
- [x] RED: Add tests proving sampling is off by default and budget-gated when enabled.
- [x] GREEN: Implement sampling mediation that returns only handler output and sanitized usage.

### Gate 2 to 3

- [x] Tool, resource, prompt, elicitation, and sampling tests pass.
- [x] Same-named capabilities across servers require qualified identity.
- [x] Sampling remains disabled unless explicitly enabled.

### M7: Model-Facing MCP Tool Surface

- [x] RED: Add tests for the chosen model-facing surface (`mcp` actions or `mcp_*` family) covering capability search, tool call, resource read, prompt get, and server status.
- [x] GREEN: Expose MCP as MCP without `tool_proxy` naming in generic prompt guidance.
- [x] RED: Add prompt guidance tests proving the model uses MCP for configured external integrations and avoids it when built-in Trevor tools are the clearer fit.
- [x] GREEN: Add bounded prompt/tool guidance with qualified identity and no full-catalog dump.
- [x] REFACTOR: Keep tool-proxy-specific service hints out of generic MCP guidance.

### M8: Doctor, Debug, And UI Status

- [x] RED: Add `/doctor` snapshot tests for configured, ready, auth-needed, failed, closed, timeout, and unconfigured server states.
- [x] GREEN: Wire MCP runtime status into doctor snapshots and debug info with redacted fields.
- [x] RED: Add web Storybook/tests for MCP status states using host read models.
- [x] GREEN: Render MCP status in existing doctor surfaces without exposing secrets.
- [x] REFACTOR: Keep service-specific tool-proxy health under service diagnostics, not the MCP runtime category.

### M9: Full E2E Capability Suite

- [x] RED: Add hermetic e2e fixture servers for stdio, Streamable HTTP, and SSE MCP transports.
- [x] GREEN: Boot host plus fixture servers and verify capability discovery/search end to end.
- [x] RED: Add e2e tests for MCP tool calls, resource list/read, prompt list/get, elicitation accept/decline/cancel, sampling denied/enabled, auth-needed, timeout, crash, and reconnect/closed transport behavior.
- [x] GREEN: Implement missing runtime wiring until every e2e capability path passes.
- [x] RED: Add e2e tests proving tool-proxy, when configured, behaves exactly like another named MCP server.
- [x] GREEN: Remove any special-case tool-proxy runtime behavior that violates the named-server abstraction.
- [x] REFACTOR: Consolidate fixture-server helpers into the appropriate test support package.

### Gate 3 to Done

- [x] Unit tests pass for registry, transports, capability cache, redaction, and model-facing actions.
- [x] Web/doctor tests pass for MCP status rendering.
- [x] Hermetic e2e covers every supported MCP capability: tools, resources, prompts, elicitation, sampling, server status, discovery/search, auth-needed, stdio, Streamable HTTP, SSE, timeout, crash, and tool-proxy-as-normal-server.
- [x] No full provider/API-key environment inheritance exists for stdio children.
- [x] No generic prompt guidance treats tool-proxy as the MCP abstraction.
