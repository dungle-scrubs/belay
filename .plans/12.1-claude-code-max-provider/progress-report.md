# Claude Code (Max Plan) Provider - Progress Report

## Summary

> Current focus: complete - all milestones landed (M4 manual EZE recorded as gated)

- Total checklist items: 23
- Completed: 23
- Current cutoff blockers: 0

## 0. Hard Dependencies

- [x] Provider system: `Provider` interface, `SourceDef`/`providerForSource`, `provider-auth.ts`, `anthropic.ts` shape
- [x] `SourceType` union (reuses `"oauth"`; no shared-package change)

## Phase 1: Provider + stream mapping

### M1: Naked SDK provider and event mapping

- [x] RED: `stream()` runs ONE `query()` with systemPrompt=passed prompt, tools:[], settingSources:[], permissionMode bypass, includePartialMessages true, and ignores the host-passed tools arg
- [x] GREEN: add `@anthropic-ai/claude-agent-sdk` dep; implement `providers/claude-code.ts` mirroring anthropic.ts
- [x] RED: mapping tests - text_delta -> text (streamed), thinking delta -> thinking, ResultMessage -> usage, terminal SDK error -> typed ProviderError
- [x] GREEN: implement the SDK-event -> ProviderEvent stream mapper
- [x] RED: capabilities() = tools:false + vision-per-model; readiness warm; describe carries label/model/reasoning
- [x] GREEN: implement capabilities/readiness/warm/describe
- [x] REFACTOR: pure spawn/mapping over an injected `query` seam (unit-tested without a live subprocess)

### M2: Subprocess env hygiene

- [x] RED: spawn-env probe - child env has CLAUDE_CODE_OAUTH_TOKEN and NO ANTHROPIC_API_KEY key, even with a stale parent ANTHROPIC_API_KEY
- [x] GREEN: build child env by deleting ANTHROPIC_API_KEY (not empty) + injecting the token
- [x] RED: missing CLAUDE_CODE_OAUTH_TOKEN -> bounded typed provider error (no silent API-credit fallthrough)
- [x] GREEN: fail closed when the token is absent

## Phase 2: Source wiring + configured signal

### M3: Catalog source + configured branch + dispatch

- [x] RED: resolveSourceAuth for claude-code = token presence, INDEPENDENT of the ~/.pi/auth.json anthropic entry (both cross cases)
- [x] GREEN: add the SourceDef row (type oauth, cliTokenEnv) + cliTokenPresent helper + the resolveSourceAuth branch
- [x] RED: providerForSource returns claudeCodeProvider for sourceId claude-code; anthropic unchanged
- [x] GREEN: add the providerForSource dispatch branch
- [x] RED: the source appears in the host.online catalog snapshot as a distinct selectable Claude source, not ready without the token
- [x] GREEN: wire the source into the catalog snapshot builder
- [x] REFACTOR: the new auth branch reads cleanly beside local/oauth/api-key; no duplicate token read

## Phase 3: Verification

### M4: Full verification + manual EZE

- [x] GREEN: lint + typecheck + full test suite green
- [x] RED: manual EZE with a real Max token - RECORDED AS GATED (no headless `CLAUDE_CODE_OAUTH_TOKEN`; see Verification record below)
- [x] REFACTOR: record verification commands; note the tool-support follow-up as a separate future plan

## Verification record (M4)

Commands run from the worktree root, all green:

- `pnpm lint` - biome (1138 files) + kebab-case filename policy: clean.
- `pnpm typecheck` - all 11 workspace projects: clean.
- `pnpm test` (`vitest run`, all projects) - **3696 passed | 3 skipped**.
  - Lanes RUN green: `unit`, `integration`, `web` (jsdom), and the hermetic `e2e` lane.
  - Lane SKIPPED with stated reason: the live-model `e2e/live/*` lane
    (`agent.test.ts`, `context.test.ts`) - `test.skipIf(!enabled)` where `enabled`
    needs `TREVOR_LIVE=1` + a running host (`RICHTER_URL`/`SESSION_ID`), absent
    headlessly. Skips, never fails (AGENTS.md gated-lane doctrine).

Manual EZE - **GATED / DEFERRED**: the EZE needs a real Max-plan
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`). None is available headlessly:
the env var is unset, there is no `~/.claude/.credentials.json`, and no
`Claude Code-credentials` keychain entry. An interactive `claude` CLI login exists on
the machine, but that is NOT the long-lived setup-token the provider reads, and
generating one requires interactive auth + would consume the Max programmatic pool, so
the EZE was not faked. When a token is available, run: select the `claude-code` source
in the chooser, send a text turn, confirm a streamed text answer + a usage row, and
confirm via the subscription's programmatic-usage view that it billed the Max pool (not
API credits). The billing-correctness invariant it validates (child env deletes
`ANTHROPIC_API_KEY`, injects `CLAUDE_CODE_OAUTH_TOKEN`) is already pinned by the M2
spawn-env probe unit tests.

Follow-ups (separate future plans, out of scope here - D-004):

- **Tool support**: this cut is text-only (`capabilities().tools = false`; the SDK gets
  `tools: []`). Exposing any tool re-enables the SDK's multi-turn loop and breaks the
  one-step `Provider.stream()` contract - a different provider shape, not a deferred
  milestone of this plan.
- **Vision passthrough**: `capabilities().images` follows the model, but the current
  prompt projection is a text transcript (image artifacts ride as an attachments note,
  not inline blocks). True inline-image passthrough via the SDK is a follow-up.
- **Programmatic-pool state in `/doctor`**: surface the Max programmatic pool if cheaply
  readable (Risk Register mitigation), so subsidized-inference value is honest.
