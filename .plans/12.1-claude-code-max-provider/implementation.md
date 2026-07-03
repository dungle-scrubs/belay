# Claude Code (Max Plan) Provider - Implementation Plan

A second Claude source, `claude-code`, that runs Claude through the TypeScript Agent SDK
(`@anthropic-ai/claude-agent-sdk`) billed to the user's Max-plan subscription, alongside the existing
`anthropic` source (raw Messages API, billed to API credits). The user picks between the two Claude
sources per turn in the model chooser, exactly like picking LM Studio vs OpenAI today. <!-- D-001 -->

## 0. Hard Dependencies

- [x] The provider system (`apps/agent-host/src/providers/`): the `Provider` interface
  (`types.ts:130` `stream(messages, tools, reasoning?)` -> `Stream<ProviderEvent, ProviderError>`),
  the `SourceDef` rows + `providerForSource` dispatch (`catalog.ts:42,340`), the auth helpers
  (`provider-auth.ts`), and the existing `anthropic` provider (`anthropic.ts`) as the shape to
  mirror. All merged.
- [x] `SourceType` union in `packages/session/src/model-source.ts:24` (`local|oauth|gateway|api-key`)
  - this source reuses `"oauth"` (see D-003); no shared-package change is required.

No dependency on plan 12 (`bounded-child-takeover`); the `12.1` number is the owner's explicit
"run soon" placement, not a real dependency. <!-- D-005 -->

## 1. Architecture

The host owns the agent loop: it calls `stream()`, receives assistant text + tool-call requests as
`ProviderEvent`s, executes tools itself, appends results, and calls `stream()` again. Providers are
dumb single-step pipes. The whole point of this plan is to make the Agent SDK - which normally runs
Claude Code's OWN multi-turn agent loop with its OWN built-in tools and system prompt - behave as
that single-step pipe. <!-- D-001 -->

### The naked-per-turn spawn (the core mechanism)

Each `Provider.stream()` call runs one Agent SDK `query()` spawned NAKED:

| SDK option | Value | Why |
|---|---|---|
| `systemPrompt` | Trevor's `buildSystemPrompt(...)` output | A custom string that FULLY REPLACES Claude Code's default. NOT the `claude_code` preset, NOT append. <!-- D-001 --> |
| `tools` (allowed tools) | `[]` | Strips ALL built-in tools at the AVAILABILITY layer (not just permission). With zero tools in context, Claude Code's agent loop has nothing to call, so it terminates after ONE text-only response - the one-step `stream()` contract. <!-- D-001 --> |
| `settingSources` | `[]` | Ignore `~/.claude/`, `.claude/`, `CLAUDE.md`, `AGENTS.md`, output styles, settings hooks. |
| `permissionMode` | `"bypassPermissions"` | No interactive permission prompts (there are no tools anyway). |
| `includePartialMessages` | `true` | Enables token streaming: `SDKPartialAssistantMessage` `content_block_delta`/`text_delta` -> `{type:"text"}` `ProviderEvent`; a thinking delta -> `{type:"thinking"}`; the final `ResultMessage` -> `{type:"usage"}`. A terminal failure rides the typed `ProviderError` channel. |

One `query()` = one model step. Cancellation is fiber interruption tearing the subprocess down, matching
`stream()`'s no-signal contract (`types.ts:126-129`).

### Subprocess auth (billing correctness)

The SDK subprocess env MUST: <!-- D-002 -->

- set `CLAUDE_CODE_OAUTH_TOKEN` (a long-lived token from `claude setup-token`) so inference bills the
  Max subscription;
- **delete `ANTHROPIC_API_KEY` from the child env entirely** (remove it, do NOT set it to `""`). The
  precedence is `ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN`, so any stale API key silently wins and
  bills API credits; the empty-string trick is unreliable.

This is a correctness + billing invariant, enforced by a spawn-env probe test (M2).

### The configured signal (a NEW auth-signal branch)

`resolveSourceAuth` (`catalog.ts:134`) today derives "configured" ONLY from `~/.pi/auth.json`
(`oauthPresent`/`staticKeyEntry`). The `claude-code` source's configured signal is instead the
presence of `CLAUDE_CODE_OAUTH_TOKEN` (env / the CLI token store) - a DIFFERENT credential store from
the `anthropic` source's `~/.pi/auth.json` OAuth entry. Marking configured from the pi entry while the
subprocess reads the CLI token store would show "ready" and fail at stream time. So this plan adds a
new branch: keep `SourceDef.type: "oauth"`, add a distinguishing field (e.g. `cliTokenEnv:
"CLAUDE_CODE_OAUTH_TOKEN"`), and a `resolveSourceAuth` arm that checks the token store, not
`~/.pi/auth.json`. <!-- D-003 -->

### Text-only in this cut (honest limitation)

Passing `tools: []` to the SDK means Claude returns a text-only response and CANNOT emit Trevor
`tool_call` events. So `capabilities()` reports `tools: false` (vision per the model) - the host then
never sends `ToolDef`s it would drop, and the model is not nudged to hallucinate tool use.
**Consequence: this Claude-via-Max is a chat / reasoning / writing model, not a tool-using one, in
this plan.** Full tool support is a different provider shape (see Non-Goals), not a deferred milestone
here. <!-- D-004 -->

### Boundaries

| Boundary | Owns | Does not own |
|---|---|---|
| `providers/claude-code.ts` (new) | The `Provider` impl: `describe`/`readiness`/`capabilities`/`warm`/`stream`; the naked `query()` spawn + env hygiene; SDK-event -> `ProviderEvent` mapping | The host agent loop; tool execution; the system-prompt content (reads `buildSystemPrompt`) |
| `catalog.ts` | The `claude-code` `SourceDef` row, the new configured-signal branch in `resolveSourceAuth`, the `providerForSource` `sourceId === "claude-code"` dispatch | The provider internals |
| `provider-auth.ts` | The CLI-token presence read (new helper beside `oauthPresent`/`staticKeyEntry`) | Anything about `~/.pi/auth.json` for this source |

New module gets a `Responsible for:` / `Not for:` header (host convention).

## 2. Non-Goals

- **Exposing ANY tool to Claude Code** - whether Trevor's tools via `createSdkMcpServer`, a Claude
  built-in (Bash/Read/Write/...), or an MCP server - is OUT OF SCOPE. With any tool in context, the
  SDK runs its own multi-turn loop and the one-step `Provider.stream()` contract breaks. That is a
  different provider shape, not a deferred milestone of this plan. <!-- D-004 -->
- **In-app sign-in for the CLI token.** The token comes from the user running `claude setup-token`
  manually; the source reports configured / not-configured and (optionally) surfaces a `/doctor`
  hint. No OAuth device-code flow is built for it in this cut (the existing `anthropic` sign-in is
  a separate credential store).
- No change to the `anthropic` source, the host agent loop, the protocol, or the web chooser beyond
  the new source appearing as one more selectable Claude row.

## 3. Phases

### Phase 1: Provider + stream mapping

#### M1: Naked SDK provider and event mapping

- **Dependencies:** hard dependencies
- **Effort:** M
- **Tasks:**
  1. RED: Add a test (fake/stubbed SDK `query`) asserting `claudeCodeProvider(...).stream(messages,
     tools, reasoning)` runs ONE `query()` with `systemPrompt` = the passed system prompt, `tools:
     []`, `settingSources: []`, `permissionMode: "bypassPermissions"`, `includePartialMessages: true`
     - and IGNORES the host-passed `tools` arg.
  2. GREEN: Add `@anthropic-ai/claude-agent-sdk` to `apps/agent-host` (pin the version); implement
     `providers/claude-code.ts` mirroring `anthropic.ts`'s shape.
  3. RED: Add mapping tests - `content_block_delta`/`text_delta` -> `{type:"text"}` (streamed), a
     thinking delta -> `{type:"thinking"}`, `ResultMessage` -> `{type:"usage"}` (input/output/window),
     and a terminal SDK error -> a typed `ProviderError` on the stream channel.
  4. GREEN: Implement the SDK-event -> `ProviderEvent` stream mapper (the pi-ai.ts analogue for this
     path).
  5. RED: Test `capabilities()` reports `tools: false` (vision per model) and `readiness()` is warm
     (cloud); `describe()` carries the `claude-code` label + model + reasoning levels.
  6. GREEN: Implement `capabilities`/`readiness`/`warm`/`describe`.
  7. REFACTOR: Keep the spawn/mapping pure over an injected `query` seam so the stream is unit-tested
     without a live subprocess.

#### M2: Subprocess env hygiene

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Spawn-env probe test - the env handed to `query()` (or the child) contains
     `CLAUDE_CODE_OAUTH_TOKEN` and has NO `ANTHROPIC_API_KEY` key at all, even when the parent process
     has a stale `ANTHROPIC_API_KEY` set. <!-- D-002 -->
  2. GREEN: Build the child env by removing `ANTHROPIC_API_KEY` (delete, not empty) and injecting
     `CLAUDE_CODE_OAUTH_TOKEN` from the token store.
  3. RED: Test that a missing `CLAUDE_CODE_OAUTH_TOKEN` yields a bounded typed provider error (not a
     silent fallthrough to API-credit billing).
  4. GREEN: Fail closed when the token is absent.

### Phase 2: Source wiring + configured signal

#### M3: Catalog source + configured branch + dispatch

- **Dependencies:** M2
- **Effort:** S
- **Tasks:**
  1. RED: Test `resolveSourceAuth` for the `claude-code` source reports `configured: true` when
     `CLAUDE_CODE_OAUTH_TOKEN` is present and `false` when absent - INDEPENDENT of the `~/.pi/auth.json`
     `anthropic` entry (present-pi + absent-token = not configured; absent-pi + present-token =
     configured). <!-- D-003 -->
  2. GREEN: Add the `claude-code` `SourceDef` row (`type: "oauth"`, `cliTokenEnv`), a
     `cliTokenPresent` helper in `provider-auth.ts`, and the `resolveSourceAuth` branch that uses it.
  3. RED: Test `providerForSource` returns `claudeCodeProvider(...)` for `sourceId === "claude-code"`
     and still returns `anthropicProvider(...)` for `sourceId === "anthropic"` (no regression).
  4. GREEN: Add the `providerForSource` dispatch branch.
  5. RED: Test the source appears in the `host.online` catalog snapshot as a distinct selectable
     source (label distinct from `anthropic`) with the right reasoning levels + `tools:false`
     capability, and does NOT show ready when the token is absent.
  6. GREEN: Wire the source into the catalog snapshot builder (it flows through the existing
     per-source projection).
  7. REFACTOR: Confirm the new auth branch reads cleanly beside the local/oauth/api-key arms; no
     duplication of the token read.

### Phase 3: Verification

#### M4: Full verification + manual EZE

- **Dependencies:** M3
- **Effort:** S
- **Tasks:**
  1. GREEN: `pnpm lint`, `pnpm typecheck`, `pnpm test` (unit/integration/web/hermetic e2e) green.
  2. RED: Manual EZE (needs a real Max-plan `CLAUDE_CODE_OAUTH_TOKEN`): select the `claude-code`
     source in the chooser, run a text turn, confirm a streamed text answer + a usage row, and
     confirm (via the subscription's programmatic-usage view) that it billed the Max pool, not API
     credits. Record as a gated/deferred EZE if no token is available headlessly.
  3. REFACTOR: Record the exact verification commands and note the tool-support follow-up (a separate
     future plan) in the progress report.

### Done Gate

- [x] `claude-code` is a selectable second Claude source, distinct from `anthropic`, that streams
  text via the Agent SDK on the Max subscription.
- [x] Subprocess env sets `CLAUDE_CODE_OAUTH_TOKEN` and never carries `ANTHROPIC_API_KEY`.
- [x] Configured signal is the CLI token, independent of `~/.pi/auth.json`.
- [x] `capabilities()` reports `tools:false`; no tool is ever exposed to the SDK.
- [x] Full suites green; manual EZE recorded as gated (no headless Max-plan token).

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation |
|---|---|---:|---|
| **Billing split erodes the motivation.** As of 2026-06-15 Anthropic split programmatic usage (`claude -p`, Agent SDK) into a SEPARATE monthly credit pool (Max 20x = $200/mo, hard-stop on exhaustion), distinct from the interactive subscription quota. The whole point of this feature is subsidized inference; the split may sharply reduce that advantage for SDK usage specifically. | high | high | Record honestly (this row). Surface the programmatic-pool state in `/doctor` if cheaply readable. Ship the feature but do not present it as free/unlimited inference; re-evaluate value after real usage. |
| Stale `ANTHROPIC_API_KEY` silently bills API credits | high | medium | Delete the key from the child env (not empty-string); spawn-env probe test (M2). |
| Configured-from-wrong-store shows ready but fails at stream | medium | medium | Configured signal is the CLI token, tested independent of `~/.pi/auth.json` (M3). |
| A future SDK version changes the "zero tools terminates the loop" behavior, breaking the one-step contract | medium | low | Pin the SDK version; the M1 one-`query()`/text-only test catches a regression on upgrade. |
| Text-only surprises the user (no tool use) | medium | medium | `capabilities().tools = false` so the host never offers tools; label/doc the source honestly; full tool support is an explicit separate plan. |

## 5. Escape Hatches

1. **If the SDK cannot be forced single-step reliably:** gate the source behind a not-ready state and
   defer; the `anthropic` source keeps working unchanged.
2. **If the billing split makes it valueless:** ship the runtime but leave the source disabled by
   default (configured only when the token is explicitly present), so the plumbing exists without
   advertising subsidized inference.

## 6. Progress Report Accounting

Use `.plans/12.1-claude-code-max-provider/progress-report.md` as the resume state. Before resuming or
declaring convergence:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "12.1-claude-code-max-provider"
```

## 7. Validation Commands

```bash
pnpm lint && pnpm typecheck && pnpm test
```

## 8. Decisions

Canonical decisions are in `.plans/12.1-claude-code-max-provider/plan.db`. Key decisions use
`<!-- D-NNN -->` markers above.
