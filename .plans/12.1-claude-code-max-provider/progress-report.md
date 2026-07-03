# Claude Code (Max Plan) Provider - Progress Report

## Summary

> Current focus: M1: Naked SDK provider and event mapping

- Total checklist items: 23
- Completed: 2
- Current cutoff blockers: 21

## 0. Hard Dependencies

- [x] Provider system: `Provider` interface, `SourceDef`/`providerForSource`, `provider-auth.ts`, `anthropic.ts` shape
- [x] `SourceType` union (reuses `"oauth"`; no shared-package change)

## Phase 1: Provider + stream mapping

### M1: Naked SDK provider and event mapping

- [ ] RED: `stream()` runs ONE `query()` with systemPrompt=passed prompt, tools:[], settingSources:[], permissionMode bypass, includePartialMessages true, and ignores the host-passed tools arg
- [ ] GREEN: add `@anthropic-ai/claude-agent-sdk` dep; implement `providers/claude-code.ts` mirroring anthropic.ts
- [ ] RED: mapping tests - text_delta -> text (streamed), thinking delta -> thinking, ResultMessage -> usage, terminal SDK error -> typed ProviderError
- [ ] GREEN: implement the SDK-event -> ProviderEvent stream mapper
- [ ] RED: capabilities() = tools:false + vision-per-model; readiness warm; describe carries label/model/reasoning
- [ ] GREEN: implement capabilities/readiness/warm/describe
- [ ] REFACTOR: pure spawn/mapping over an injected `query` seam (unit-tested without a live subprocess)

### M2: Subprocess env hygiene

- [ ] RED: spawn-env probe - child env has CLAUDE_CODE_OAUTH_TOKEN and NO ANTHROPIC_API_KEY key, even with a stale parent ANTHROPIC_API_KEY
- [ ] GREEN: build child env by deleting ANTHROPIC_API_KEY (not empty) + injecting the token
- [ ] RED: missing CLAUDE_CODE_OAUTH_TOKEN -> bounded typed provider error (no silent API-credit fallthrough)
- [ ] GREEN: fail closed when the token is absent

## Phase 2: Source wiring + configured signal

### M3: Catalog source + configured branch + dispatch

- [ ] RED: resolveSourceAuth for claude-code = token presence, INDEPENDENT of the ~/.pi/auth.json anthropic entry (both cross cases)
- [ ] GREEN: add the SourceDef row (type oauth, cliTokenEnv) + cliTokenPresent helper + the resolveSourceAuth branch
- [ ] RED: providerForSource returns claudeCodeProvider for sourceId claude-code; anthropic unchanged
- [ ] GREEN: add the providerForSource dispatch branch
- [ ] RED: the source appears in the host.online catalog snapshot as a distinct selectable Claude source, not ready without the token
- [ ] GREEN: wire the source into the catalog snapshot builder
- [ ] REFACTOR: the new auth branch reads cleanly beside local/oauth/api-key; no duplicate token read

## Phase 3: Verification

### M4: Full verification + manual EZE

- [ ] GREEN: lint + typecheck + full test suite green
- [ ] RED: manual EZE with a real Max token - select claude-code, run a text turn, confirm streamed text + usage + Max-pool billing (record as gated if no token headlessly)
- [ ] REFACTOR: record verification commands; note the tool-support follow-up as a separate future plan
