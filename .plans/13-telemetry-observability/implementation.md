# Trevor Telemetry and Observability - Implementation Plan

## 0. Hard Dependencies

- [ ] `03-filesystem-root-taxonomy` - telemetry artifacts and diagnostic streams use `TREVOR_STATE_HOME` instead of `TREVOR_HOME`.
- [x] H-072/H-073/H-101 `Deep telemetry` has been rebaselined into this plan instead of becoming a second telemetry plan.
- [ ] `.plans/09.1-mid-turn-model-switch` makes one turn span multiple models/reasoning levels and emits a `model.switched` event; turn and provider telemetry must treat model/reasoning as per-segment, and a per-turn switch count is surfaced as a low-cardinality metric. <!-- D-010 -->

## Architecture

<!-- D-001 --> Trevor's observability architecture is OTel-first, local/free by default, and remote-opt-in. Runtime apps initialize telemetry at their process or browser edge; shared packages define contracts, redaction, span names, metric names, and config helpers but never initialize Sentry or a global OTel SDK.

This plan also owns the former umbrella `Deep telemetry` backlog item: OTel span export, opt-in provider-attempt JSONL traces, and bounded diagnostic result artifacts for tool outputs. Diagnostic result artifacts are for debugging and postmortem inspection only; they are not a behavioral tool-output cache and must never be used to skip or replay a tool call. <!-- D-008 -->

```
apps/web              apps/agent-host          apps/session-store
   |                       |                         |
   +---- runtime telemetry bootstrap ----------------+
                           |
                shared observability contract
                           |
        no-op | local file | local OTLP | Sentry errors
                           |
       TREVOR_STATE_HOME    optional Alloy -> Tempo -> Grafana
```

### Key Constraints

| Constraint | Impact |
|---|---|
| Cost is the primary remote-telemetry constraint | <!-- D-002 --> Sentry receives error events only by default; traces, logs, replays, profiles, and metrics are off |
| No outbound telemetry by default | OSS checkout, tests, CI, and Storybook emit nothing remote without explicit env |
| Privacy still applies | Prompt text, transcript bodies, tool output, command output, env values, auth headers, and file contents never leave the machine |
| Diagnostic artifacts are not behavioral caches | Tool-result artifacts can preserve bounded/redacted debugging evidence, but they never satisfy future tool calls |
| `TREVOR_HOME` is not for diagnostic streams | <!-- D-004 --> Detached logs, OTel artifacts, metrics, and trace files move under `TREVOR_STATE_HOME` |
| Packages are libraries | <!-- D-003 --> Packages may expose telemetry contracts, but apps own runtime initialization |
| `/doctor` is the local inspection surface | <!-- D-007 --> Telemetry mode, exporter health, drops, and roots are visible without visiting Sentry or Grafana |

### Boundaries

- `packages/observability` or equivalent shared module owns telemetry vocabulary, redaction helpers, resource attributes, span names, metric names, and config parsing.
- `apps/agent-host` owns Effect-integrated spans for turns, providers, tools, recovery, cancellation, and terminal stop causes.
- `apps/web` owns browser error capture, React error boundaries, and optional Sentry init from `VITE_TREVOR_SENTRY_DSN`.
- `apps/session-store` and `apps/blob-store` own Node service error capture and spans around HTTP, WS, SQLite, blob IO, hashing, normalization, and reject paths.
- `apps/trevor-cli` owns launch lifecycle diagnostics and detached process log redirection.
- Runtime Sentry projects are `trevor-web` and `trevor-node`; packages do not get projects.

### Observability

The implementation must answer these questions:

- What happened? Structured boundary logs and local JSONL artifacts.
- Why did it fail? Typed errors, failure classes, fingerprints, and Sentry errors for unexpected failures only.
- Where did time go? OTel-compatible spans at public module boundaries.
- How much happened? Low-cardinality metrics and local summaries.
- Is telemetry healthy? `/doctor` exporter status, mode, root paths, and drop counts.
- What was sent remotely? A local send ledger with sanitized event metadata and drop reasons.
- What did the provider/tool boundary receive and return? Opt-in local provider-attempt JSONL traces and bounded diagnostic result artifacts, with raw prompt/tool output redacted or stored only as explicitly local, size-capped artifacts.

### Alloy and Tempo

<!-- D-005 --> Alloy and Tempo are optional local tools. Alloy is the collector/agent: it receives OTLP, filters or batches it, and exports it elsewhere. Tempo is the trace backend: it stores traces and lets Grafana query them. Trevor must run without either; the local file exporter is the baseline free path.

## Phases

### Phase 1: Storage, Config, and No-op Boundary

**Goal:** Telemetry has a single config model, a safe default mode, and correct local-state storage before any exporter exists.

**Gate from previous:** None.

#### M1: State-root correction and telemetry config

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving detached service logs resolve under `TREVOR_STATE_HOME/logs`, not `TREVOR_HOME/logs`.
  2. GREEN: Update `apps/trevor-cli` log redirection to use the local state root.
  3. RED: Add tests for telemetry config defaults: no remote telemetry, no Sentry, no traces, no logs, no replay.
  4. GREEN: Implement config parsing for `TREVOR_OTEL_EXPORTER`, `TREVOR_SENTRY_DSN`/`SENTRY_DSN`, `VITE_TREVOR_SENTRY_DSN`, `TREVOR_TELEMETRY_REMOTE`, and test/CI disable guards.
  5. REFACTOR: Centralize root/config helpers so apps do not hand-roll home/state paths.

#### M2: Shared observability contract

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add unit tests for redaction blocking prompts, tool output, auth headers, API keys, env values, raw provider bodies, and raw paths.
  2. GREEN: Add shared redaction and safe-envelope helpers.
  3. RED: Add tests for allowed/disallowed metric labels and span attributes.
  4. GREEN: Define resource attributes, span names, metric names, and cardinality guards.
  5. REFACTOR: Keep package code side-effect-free; apps call explicit bootstrap functions.

### Gate 1 to 2

- [ ] `pnpm test:unit` passes for root/config/redaction tests
- [ ] CLI detached logs no longer write under `TREVOR_HOME/logs`
- [ ] No package initializes Sentry or a global OTel SDK

### Phase 2: Local OTel Instrumentation

**Goal:** Trevor emits useful local traces and metrics without any remote backend.

**Gate from previous:** Phase 1 gates pass.

#### M3: Node service spans

- **Dependencies:** M2
- **Effort:** L
- **Tasks:**
  1. RED: Add host tests with a fake in-memory span sink for turn, provider, tool, cancellation, retry, and terminal stop spans.
  2. GREEN: Instrument `apps/agent-host` public boundaries using the host's Effect call graph.
  3. RED: Add session-store and blob-store tests for HTTP/WS/SQLite/blob spans and failure status.
  4. GREEN: Instrument session-store and blob-store boundaries.
  5. REFACTOR: Keep span attributes bounded and contract-owned, not ad hoc strings per module.

#### M4: Web and CLI spans

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add web tests for connect, publish, artifact upload, and render-crash instrumentation through a fake sink.
  2. GREEN: Add browser telemetry bootstrap in disabled/local modes.
  3. RED: Add CLI tests for launch, service readiness, host spawn/reuse, browser-open, stop, kill, and archive telemetry envelopes.
  4. GREEN: Add CLI boundary spans and launch diagnostics.
  5. REFACTOR: Ensure all web telemetry avoids raw prompt and artifact bytes.

#### M5: Metrics and local file export

- **Dependencies:** M3, M4
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving metrics reject high-cardinality labels such as run id, session id, raw URL, raw path, prompt, and command string.
  2. GREEN: Add low-cardinality metrics for turn duration, stop cause, provider latency, tool duration, exporter drops, retry counts, context pressure, service errors, and blob upload/fetch outcomes.
  3. RED: Add tests proving a per-turn model-switch count is recorded as a low-cardinality metric and that model id and reasoning stay bounded labels, not high-cardinality like run id or prompt.
  4. GREEN: Add a low-cardinality model-switch metric (count per turn with applied/blocked outcome) and record `model.switched` from `.plans/09.1-mid-turn-model-switch` as a turn-span boundary so multi-model turns are observable. <!-- D-010 -->
  5. RED: Add tests proving `TREVOR_OTEL_EXPORTER=file` writes bounded local artifacts under `TREVOR_STATE_HOME/otel`.
  6. GREEN: Implement local JSONL or OTLP JSON export with size caps and best-effort failure handling.
  7. REFACTOR: Add a send/drop ledger that records sanitized event metadata and drop reasons.

#### M6: Provider attempts and diagnostic result artifacts

- **Dependencies:** M3, M5
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving provider-attempt JSONL traces are disabled by default and opt in through explicit local telemetry config.
  2. GREEN: Emit bounded provider-attempt JSONL records under `TREVOR_STATE_HOME` with provider id, model id, attempt id, failure class, token/count metadata, timing, retry state, and redacted request/response summaries.
  3. RED: Add tests proving raw prompts, transcript bodies, tool output, command output, auth headers, env values, and raw provider bodies are redacted or replaced with local artifact references.
  4. GREEN: Store bounded diagnostic result artifacts for oversized provider/tool evidence under the telemetry artifact root with size caps, retention policy, and `/doctor` visibility.
  5. REFACTOR: Prove diagnostic result artifacts are never used as a behavioral tool-output cache or to skip/replay a future tool call.

### Gate 2 to 3

- [ ] Host, web, store, blob, and CLI unit/integration tests cover fake sink instrumentation
- [ ] Local file export works with no network
- [ ] Provider-attempt JSONL traces are opt-in, local-only, bounded, and redacted
- [ ] Diagnostic result artifacts are retained only for debugging and never used as tool-call output cache
- [ ] Exporter failures never fail user turns, service writes, uploads, or CLI launches

### Phase 3: Doctor and Optional Local Collector Stack

**Goal:** Local telemetry is inspectable through `/doctor`, and users can optionally run a free local collector stack.

**Gate from previous:** Phase 2 gates pass.

#### M7: `/doctor` telemetry area

- **Dependencies:** M5, M6
- **Effort:** M
- **Tasks:**
  1. RED: Add doctor snapshot tests for disabled, local-file, local-OTLP, Sentry-enabled, degraded, and exporter-drop states.
  2. GREEN: Add a telemetry area to `/doctor` with mode, exporter health, last success/failure, local roots, sampling, drops, and redaction self-test status.
  3. RED: Add web doctor tests and Storybook fixtures for the telemetry area.
  4. GREEN: Render telemetry diagnostics in the existing doctor UI.
  5. REFACTOR: Keep DSNs, tokens, endpoints with credentials, prompts, and raw paths out of doctor output.

#### M8: Optional OTLP, Alloy, and Tempo

- **Dependencies:** M5, M7
- **Effort:** M
- **Tasks:**
  1. RED: Add config tests requiring non-loopback OTLP endpoints to opt in through `TREVOR_ALLOW_REMOTE_OTEL=1`.
  2. GREEN: Implement OTLP export behind explicit config and bounded retry/drop behavior.
  3. RED: Add documentation tests or static checks for local-stack docs, ports, and no-default-start behavior.
  4. GREEN: Add optional local stack docs and, if implemented, a Docker Compose file for Alloy, Tempo, and Grafana.
  5. REFACTOR: If any persistent local service ports are introduced, update `~/.agents/PORTS.md` in the same implementation change.

### Gate 3 to 4

- [ ] `/doctor` shows telemetry state without exposing secrets
- [ ] Local OTLP export works against a loopback collector
- [ ] Trevor still runs with no collector installed

### Phase 4: Opt-in Sentry Errors

**Goal:** The maintainer can get Sentry issue grouping for unexpected Node and web failures while staying cost-controlled.

**Gate from previous:** Phase 3 gates pass, or Phase 1 plus a scoped decision to land Sentry first.

#### M9: Node Sentry error sink

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving Node Sentry is disabled without DSN and disabled in tests/CI by default.
  2. GREEN: Add Node Sentry bootstrap for `agent-host`, `session-store`, `blob-store`, and optionally `trevor-cli`.
  3. RED: Add before-send tests proving prompt text, tool output, env values, auth headers, raw paths, and raw provider bodies are dropped or redacted.
  4. GREEN: Capture unhandled exceptions, unhandled rejections, invariant breaches, and fatal service failures as sanitized events.
  5. REFACTOR: Do not capture expected typed provider/tool/session failures as Sentry exceptions by default.

#### M10: Web Sentry error sink

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add web tests proving Sentry is disabled without `VITE_TREVOR_SENTRY_DSN`.
  2. GREEN: Add React/browser Sentry bootstrap and an error boundary path for render crashes.
  3. RED: Add tests proving browser events exclude prompts, transcript bodies, artifact bytes, and raw URLs.
  4. GREEN: Capture sanitized React render crashes and unexpected browser exceptions.
  5. REFACTOR: Keep browser tracing, replay, logs, profiles, and metrics disabled by default.

#### M11: Release and source map policy

- **Dependencies:** M9, M10
- **Effort:** S
- **Tasks:**
  1. RED: Add script/config tests proving source map upload is skipped unless `SENTRY_AUTH_TOKEN` and explicit release env are present.
  2. GREEN: Add optional release/source-map upload scripts or docs without enabling them in default CI.
  3. RED: Add tests proving release and environment tags are bounded and present when configured.
  4. GREEN: Tag Sentry events with service name, release, environment, provider/tool names where safe, and sanitized fingerprints.
  5. REFACTOR: Keep public OSS build free of embedded DSNs and auth tokens.

### Gate 4 to 5

- [ ] Sentry receives only explicit sanitized error events in maintainer-configured runs
- [ ] Traces, logs, replays, profiles, and metrics are off by default for Sentry
- [ ] Expected typed failures do not create Sentry issue noise

### Phase 5: Cost, Redaction, and EZE Verification

**Goal:** The plan is proven in realistic local use without surprise remote volume.

**Gate from previous:** Phase 4 gates pass.

#### M12: Cost guardrails

- **Dependencies:** M9, M10
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving remote traces/logs/replays/profiles/metrics cannot turn on unless explicit env flags are present.
  2. GREEN: Add cost guardrails, sampling config, and drop counters.
  3. RED: Add tests for sampling and max-events-per-process/session caps.
  4. GREEN: Enforce caps locally and expose drop counts in `/doctor`.
  5. REFACTOR: Document free-tier posture and how to temporarily enable more telemetry for debugging.

#### M13: End-to-end and manual validation

- **Dependencies:** M12
- **Effort:** M
- **Tasks:**
  1. RED: Add hermetic e2e coverage for no-DSN no-outbound behavior.
  2. GREEN: Verify host, web, store, blob, and CLI still operate when exporters fail.
  3. RED: Add a local-stack smoke that skips with a stated reason when Docker or collector prerequisites are absent.
  4. GREEN: Validate local file export and optional Alloy to Tempo trace viewing.
  5. REFACTOR: Update docs and `/doctor` copy based on manual EZE findings.

### Gate 5 complete

- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] Manual EZE repro: no DSN means no remote telemetry
- [ ] Manual EZE repro: configured Sentry receives one sanitized test error and no traces/logs/replays/profiles
- [ ] Manual EZE repro: local file export writes inspectable traces/metrics under `TREVOR_STATE_HOME`
- [ ] Manual EZE repro: optional local Alloy/Tempo stack can show a trace, or skips with documented prerequisites

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---|---|---|---|
| Sentry cost grows unexpectedly | high | medium | Error-only default, remote trace/log/replay/profile/metric off, caps, sampling, `/doctor` drops | Trevor |
| Sensitive local data leaves the machine | high | medium | Shared redaction, before-send filtering, tests, local-first export | Trevor |
| Telemetry failures affect user work | high | low | Best-effort exporters, no-op fallback, degraded state, tests | Trevor |
| Instrumentation becomes noisy | medium | medium | Public-boundary spans only, low-cardinality metrics, expected failures not captured as exceptions | Trevor |
| Local stack adds operational burden | medium | medium | Optional only, local file export baseline, skip-aware smoke | Trevor |
| Storage roots drift again | medium | medium | Root helper centralization, tests, `/doctor` root report | Trevor |

## Escape Hatches

1. **If Sentry setup creates noise or cost:** Disable Sentry sink entirely and keep local OTel plus `/doctor`.
2. **If OTel SDK integration fights Effect or browser bundling:** Keep the shared contract and emit local JSONL spans first, then add SDK exporters later.
3. **If Alloy/Tempo is too much machinery:** Keep the local file exporter and document external collector setup instead of shipping Docker config.
4. **If source maps are fragile:** Skip source map upload and rely on local stack traces until release automation is mature.

## Progress Report Accounting

The progress report in this plan is the resume state. Current-cutoff blockers are the unchecked items under active milestones. Deferred options, such as source map upload and local collector stack ports, must not be counted as blockers unless they are promoted into a milestone.

Before resuming implementation, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "13-telemetry-observability"
```

## Validation Commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:unit
pnpm test:integration
pnpm test:web
pnpm test:e2e
```

## Decisions

Canonical decisions are recorded in `.plans/13-telemetry-observability/plan.db`.

Key decisions:

- <!-- D-001 --> OTel-first, local/free by default.
- <!-- D-002 --> Sentry is opt-in error capture, not the full telemetry backend.
- <!-- D-004 --> Diagnostic streams and telemetry artifacts live under `TREVOR_STATE_HOME`.
- <!-- D-003 --> Packages do not initialize Sentry or global OTel runtime state.
- <!-- D-005 --> Alloy and Tempo are optional local tools, not runtime dependencies.
