# Trevor Telemetry and Observability - Progress Report

> Scope: new standalone planner plan for Trevor telemetry, Sentry, and local/free OTel instrumentation. It does not modify the canonical Trevor V2 implementation plan.
> Current focus: Phase 2, M3 - Node service spans (Phase 1 M1-M2 complete).
> Rebaseline: H-072/H-073/H-101 `Deep telemetry` now belongs here: OTel span export, opt-in provider-attempt JSONL traces, and diagnostic result artifacts. Diagnostic result artifacts are not a behavioral tool-output cache.

## Summary

- Current cutoff blockers: 75
- Completed: 13
- Deferred follow-up: 2
- Superseded: 0

## Phase 1: Storage, Config, and No-op Boundary

### M1: State-root correction and telemetry config

- [x] RED: Add tests proving detached service logs resolve under `TREVOR_STATE_HOME/logs`, not `TREVOR_HOME/logs`
- [x] GREEN: Update `apps/trevor-cli` log redirection to use the local state root (already correct - the plan-03 XDG state-home split moved `platform.ts` log redirection to `TREVOR_STATE_HOME/logs`; locked in with a characterization test on `storagePathByName("logs")`)
- [x] RED: Add tests for telemetry config defaults: no remote telemetry, no Sentry, no traces, no logs, no replay
- [x] GREEN: Implement config parsing for `TREVOR_OTEL_EXPORTER`, `TREVOR_SENTRY_DSN`/`SENTRY_DSN`, `VITE_TREVOR_SENTRY_DSN`, `TREVOR_TELEMETRY_REMOTE`, and test/CI disable guards (`packages/session/src/telemetry.ts`, `@trevor/session/telemetry`)
- [x] REFACTOR: Centralize root/config helpers so apps do not hand-roll home/state paths (paths via `node-paths` `storagePathByName`; telemetry config via the one `resolveTelemetryConfig`)

### M2: Shared observability contract

- [x] RED: Add unit tests for redaction blocking prompts, tool output, auth headers, API keys, env values, raw provider bodies, and raw paths
- [x] GREEN: Add shared redaction and safe-envelope helpers (`telemetry-contract.ts`: `redactSecrets`, `redactAttributeValue`, `safeAttributes` - drops disallowed keys by KEY + secret-strips surviving VALUEs)
- [x] RED: Add tests for allowed/disallowed metric labels and span attributes
- [x] GREEN: Define resource attributes, span names, metric names, and cardinality guards (`SPAN_NAMES`, `METRIC_NAMES`, `resourceAttributes`, `isDisallowedTelemetryKey`)
- [x] REFACTOR: Keep package code side-effect-free; apps call explicit bootstrap functions (contract is pure; no SDK/Sentry init in any package)

### Gate 1 to 2

- [x] `pnpm test:unit` passes for root/config/redaction tests
- [x] CLI detached logs no longer write under `TREVOR_HOME/logs`
- [x] No package initializes Sentry or a global OTel SDK

## Phase 2: Local OTel Instrumentation

### M3: Node service spans

- [ ] RED: Add host tests with a fake in-memory span sink for turn, provider, tool, cancellation, retry, and terminal stop spans
- [ ] GREEN: Instrument `apps/agent-host` public boundaries using the host's Effect call graph
- [ ] RED: Add session-store and blob-store tests for HTTP/WS/SQLite/blob spans and failure status
- [ ] GREEN: Instrument session-store and blob-store boundaries
- [ ] REFACTOR: Keep span attributes bounded and contract-owned, not ad hoc strings per module

### M4: Web and CLI spans

- [ ] RED: Add web tests for connect, publish, artifact upload, and render-crash instrumentation through a fake sink
- [ ] GREEN: Add browser telemetry bootstrap in disabled/local modes
- [ ] RED: Add CLI tests for launch, service readiness, host spawn/reuse, browser-open, stop, kill, and archive telemetry envelopes
- [ ] GREEN: Add CLI boundary spans and launch diagnostics
- [ ] REFACTOR: Ensure all web telemetry avoids raw prompt and artifact bytes

### M5: Metrics and local file export

- [ ] RED: Add tests proving metrics reject high-cardinality labels such as run id, session id, raw URL, raw path, prompt, and command string
- [ ] GREEN: Add low-cardinality metrics for turn duration, stop cause, provider latency, tool duration, exporter drops, retry counts, context pressure, service errors, and blob upload/fetch outcomes
- [ ] RED: Add tests proving a per-turn model-switch count is recorded as a low-cardinality metric and that model id and reasoning stay bounded labels, not high-cardinality like run id or prompt
- [ ] GREEN: Add a low-cardinality model-switch metric (count per turn with applied/blocked outcome) and record `model.switched` from `.plans/09.1-mid-turn-model-switch` as a turn-span boundary so multi-model turns are observable
- [ ] RED: Add tests proving `TREVOR_OTEL_EXPORTER=file` writes bounded local artifacts under `TREVOR_STATE_HOME/otel`
- [ ] GREEN: Implement local JSONL or OTLP JSON export with size caps and best-effort failure handling
- [ ] REFACTOR: Add a send/drop ledger that records sanitized event metadata and drop reasons

### M6: Provider attempts and diagnostic result artifacts

- [ ] RED: Add tests proving provider-attempt JSONL traces are disabled by default and opt in through explicit local telemetry config
- [ ] GREEN: Emit bounded provider-attempt JSONL records under `TREVOR_STATE_HOME` with provider id, model id, attempt id, failure class, token/count metadata, timing, retry state, and redacted request/response summaries
- [ ] RED: Add tests proving raw prompts, transcript bodies, tool output, command output, auth headers, env values, and raw provider bodies are redacted or replaced with local artifact references
- [ ] GREEN: Store bounded diagnostic result artifacts for oversized provider/tool evidence under the telemetry artifact root with size caps, retention policy, and `/doctor` visibility
- [ ] REFACTOR: Prove diagnostic result artifacts are never used as a behavioral tool-output cache or to skip/replay a future tool call

### Gate 2 to 3

- [ ] Host, web, store, blob, and CLI unit/integration tests cover fake sink instrumentation
- [ ] Local file export works with no network
- [ ] Provider-attempt JSONL traces are opt-in, local-only, bounded, and redacted
- [ ] Diagnostic result artifacts are retained only for debugging and never used as tool-call output cache
- [ ] Exporter failures never fail user turns, service writes, uploads, or CLI launches

## Phase 3: Doctor and Optional Local Collector Stack

### M7: `/doctor` telemetry area

- [ ] RED: Add doctor snapshot tests for disabled, local-file, local-OTLP, Sentry-enabled, degraded, and exporter-drop states
- [ ] GREEN: Add a telemetry area to `/doctor` with mode, exporter health, last success/failure, local roots, sampling, drops, and redaction self-test status
- [ ] RED: Add web doctor tests and Storybook fixtures for the telemetry area
- [ ] GREEN: Render telemetry diagnostics in the existing doctor UI
- [ ] REFACTOR: Keep DSNs, tokens, endpoints with credentials, prompts, and raw paths out of doctor output

### M8: Optional OTLP, Alloy, and Tempo

- [ ] RED: Add config tests requiring non-loopback OTLP endpoints to opt in through `TREVOR_ALLOW_REMOTE_OTEL=1`
- [ ] GREEN: Implement OTLP export behind explicit config and bounded retry/drop behavior
- [ ] RED: Add documentation tests or static checks for local-stack docs, ports, and no-default-start behavior
- [ ] GREEN: Add optional local stack docs and, if implemented, a Docker Compose file for Alloy, Tempo, and Grafana
- [ ] REFACTOR: If any persistent local service ports are introduced, update `~/.agents/PORTS.md` in the same implementation change

### Gate 3 to 4

- [ ] `/doctor` shows telemetry state without exposing secrets
- [ ] Local OTLP export works against a loopback collector
- [ ] Trevor still runs with no collector installed

## Phase 4: Opt-in Sentry Errors

### M9: Node Sentry error sink

- [ ] RED: Add tests proving Node Sentry is disabled without DSN and disabled in tests/CI by default
- [ ] GREEN: Add Node Sentry bootstrap for `agent-host`, `session-store`, `blob-store`, and optionally `trevor-cli`
- [ ] RED: Add before-send tests proving prompt text, tool output, env values, auth headers, raw paths, and raw provider bodies are dropped or redacted
- [ ] GREEN: Capture unhandled exceptions, unhandled rejections, invariant breaches, and fatal service failures as sanitized events
- [ ] REFACTOR: Do not capture expected typed provider/tool/session failures as Sentry exceptions by default

### M10: Web Sentry error sink

- [ ] RED: Add web tests proving Sentry is disabled without `VITE_TREVOR_SENTRY_DSN`
- [ ] GREEN: Add React/browser Sentry bootstrap and an error boundary path for render crashes
- [ ] RED: Add tests proving browser events exclude prompts, transcript bodies, artifact bytes, and raw URLs
- [ ] GREEN: Capture sanitized React render crashes and unexpected browser exceptions
- [ ] REFACTOR: Keep browser tracing, replay, logs, profiles, and metrics disabled by default

### M11: Release and source map policy

- [ ] RED: Add script/config tests proving source map upload is skipped unless `SENTRY_AUTH_TOKEN` and explicit release env are present
- [ ] GREEN: Add optional release/source-map upload scripts or docs without enabling them in default CI
- [ ] RED: Add tests proving release and environment tags are bounded and present when configured
- [ ] GREEN: Tag Sentry events with service name, release, environment, provider/tool names where safe, and sanitized fingerprints
- [ ] REFACTOR: Keep public OSS build free of embedded DSNs and auth tokens

### Gate 4 to 5

- [ ] Sentry receives only explicit sanitized error events in maintainer-configured runs
- [ ] Traces, logs, replays, profiles, and metrics are off by default for Sentry
- [ ] Expected typed failures do not create Sentry issue noise

## Phase 5: Cost, Redaction, and EZE Verification

### M12: Cost guardrails

- [ ] RED: Add tests proving remote traces/logs/replays/profiles/metrics cannot turn on unless explicit env flags are present
- [ ] GREEN: Add cost guardrails, sampling config, and drop counters
- [ ] RED: Add tests for sampling and max-events-per-process/session caps
- [ ] GREEN: Enforce caps locally and expose drop counts in `/doctor`
- [ ] REFACTOR: Document free-tier posture and how to temporarily enable more telemetry for debugging

### M13: End-to-end and manual validation

- [ ] RED: Add hermetic e2e coverage for no-DSN no-outbound behavior
- [ ] GREEN: Verify host, web, store, blob, and CLI still operate when exporters fail
- [ ] RED: Add a local-stack smoke that skips with a stated reason when Docker or collector prerequisites are absent
- [ ] GREEN: Validate local file export and optional Alloy to Tempo trace viewing
- [ ] REFACTOR: Update docs and `/doctor` copy based on manual EZE findings

### Gate 5 complete

- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] Manual EZE repro: no DSN means no remote telemetry
- [ ] Manual EZE repro: configured Sentry receives one sanitized test error and no traces/logs/replays/profiles
- [ ] Manual EZE repro: local file export writes inspectable traces/metrics under `TREVOR_STATE_HOME`
- [ ] Manual EZE repro: optional local Alloy/Tempo stack can show a trace, or skips with documented prerequisites

## Accepted/Deferred Follow-up

- [ ] Decide exact local-stack ports and update `~/.agents/PORTS.md` when persistent local services are introduced
- [ ] Decide whether maintainer-only Sentry source map upload is worth adding after basic error capture works
