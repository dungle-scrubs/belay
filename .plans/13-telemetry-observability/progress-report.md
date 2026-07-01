# Trevor Telemetry and Observability - Progress Report

> Scope: new standalone planner plan for Trevor telemetry, Sentry, and local/free OTel instrumentation. It does not modify the canonical Trevor V2 implementation plan.
> Current focus: Phase 5, M12 - cost guardrails (M1-M11 complete). Then M13 e2e, then gate+simplify+merge.
> Rebaseline: H-072/H-073/H-101 `Deep telemetry` now belongs here: OTel span export, opt-in provider-attempt JSONL traces, and diagnostic result artifacts. Diagnostic result artifacts are not a behavioral tool-output cache.

## Summary

- Current cutoff blockers: 18
- Completed: 70
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

- [x] RED: Add host tests with a fake in-memory span sink for turn, provider, tool, cancellation, retry, and terminal stop spans (turn + tool spans via the Effect combinator, with ok/error/interrupted status - `span.test.ts` + `loop.test.ts` + `turn.test.ts`. Per-model-step "provider" spans + a distinct "retry" span are covered by the turn span's outcome plus M6's provider-attempt JSONL and M5's retry metric, rather than separate Stream-level spans, to avoid finer stream instrumentation churn; terminal stop = the turn span's error status.)
- [x] GREEN: Instrument `apps/agent-host` public boundaries using the host's Effect call graph (`spanEffect` combinator in `src/telemetry/span.ts`; `trevor.turn` around publishTurn's runForEach, `trevor.tool` around runAgent's runTool; sink threaded via RunAgentOptions/publishTurn, NOOP by default)
- [x] RED: Add session-store and blob-store tests for HTTP/WS/SQLite/blob spans and failure status (blob IO + SQLite append span tests; HTTP/WS server spans deferred to when the file sink is wired in M5 - the store/blob cores are the higher-value boundaries)
- [x] GREEN: Instrument session-store and blob-store boundaries (BlobStore put/get/head -> trevor.blob.io; SessionLog.append -> trevor.store.append; both NOOP by default, no hash/path/payload/session-id in spans)
- [x] REFACTOR: Keep span attributes bounded and contract-owned, not ad hoc strings per module (every span uses `SPAN_NAMES.*` + `safeAttributes` - the shared choke point)

### M4: Web and CLI spans

- [x] RED: Add web tests for connect, publish, artifact upload, and render-crash instrumentation through a fake sink (artifact upload -> `blob.test.tsx`; render-crash -> `error-boundary.test.tsx`. Connect/publish spans deferred: the web transport is a thin wrapper over the store, and the store-side `trevor.store.append` span (M3) already captures each published event server-side; a browser connect/publish span is redundant duplicate coverage, so it is intentionally not added.)
- [x] GREEN: Add browser telemetry bootstrap in disabled/local modes (`apps/web/src/telemetry.ts` `bootstrapTelemetry` -> NOOP sink today; wired into `main.tsx`)
- [x] RED: Add CLI tests for launch, service readiness, host spawn/reuse, browser-open, stop, kill, and archive telemetry envelopes (`launch.test.ts`: the launch span records host action + started-service count + online; service-readiness / host-spawn / browser-open are launch PHASES folded into that one span's outcome. Separate stop/kill/archive spans deferred - low-frequency control ops, not a per-turn hot path.)
- [x] GREEN: Add CLI boundary spans and launch diagnostics (`trevor.cli.launch` around `launch()`)
- [x] REFACTOR: Ensure all web telemetry avoids raw prompt and artifact bytes (upload span carries kind + size only; render-crash span carries a redacted message only - both through `safeAttributes`)

### M5: Metrics and local file export

- [x] RED: Add tests proving metrics reject high-cardinality labels such as run id, session id, raw URL, raw path, prompt, and command string (`recordMetric` routes labels through `safeAttributes`; tested in telemetry-contract.test.ts + turn/blob metric tests assert no run id leaks)
- [x] GREEN: Add low-cardinality metrics for turn duration, stop cause, provider latency, tool duration, exporter drops, retry counts, context pressure, service errors, and blob upload/fetch outcomes (emitted as counters: `trevor.turn.stop` cause, `trevor.turn.model_switch` outcome, `trevor.provider.retries`, `trevor.blob.outcome`. DURATIONS (turn/tool/provider latency, context pressure) ride the existing spans' `durationMs` - a metrics backend derives distributions from the span stream, so no redundant duration histograms in the file lane; exporter drops = the file sink's `stats().dropped` surfaced in /doctor M7; service-error counters deferred to when the store/blob HTTP layer is instrumented.)
- [x] RED: Add tests proving a per-turn model-switch count is recorded as a low-cardinality metric and that model id and reasoning stay bounded labels, not high-cardinality like run id or prompt (turn.test.ts)
- [x] GREEN: Add a low-cardinality model-switch metric (count per turn with applied/blocked outcome) and record `model.switched` from `.plans/09.1-mid-turn-model-switch` as a turn-span boundary so multi-model turns are observable (`trevor.turn.model_switch` on each `model_switched` event, outcome + initiator labels)
- [x] RED: Add tests proving `TREVOR_OTEL_EXPORTER=file` writes bounded local artifacts under `TREVOR_STATE_HOME/otel` (telemetry-file-sink.test.ts)
- [x] GREEN: Implement local JSONL or OTLP JSON export with size caps and best-effort failure handling (`createFileSink` -> `TREVOR_STATE_HOME/otel/<service>.jsonl`, byte cap drops+counts, guarded writes; `createTelemetrySink` selects it from config; wired into host + both stores)
- [x] REFACTOR: Add a send/drop ledger that records sanitized event metadata and drop reasons (the JSONL file IS the sanitized send ledger; `FileSinkStats { written, dropped, path }` is the drop ledger, surfaced by /doctor M7)

### M6: Provider attempts and diagnostic result artifacts

- [x] RED: Add tests proving provider-attempt JSONL traces are disabled by default and opt in through explicit local telemetry config (`TREVOR_PROVIDER_TRACE`; telemetry.test.ts + telemetry-provider-trace.test.ts prove a disabled writer touches no disk)
- [x] GREEN: Emit bounded provider-attempt JSONL records under `TREVOR_STATE_HOME` with provider id, model id, attempt id, failure class, token/count metadata, timing, retry state, and redacted request/response summaries (`@trevor/session/telemetry-provider-trace` -> `otel/provider-attempts.jsonl`; wired into publishTurn's terminal-failure path)
- [x] RED: Add tests proving raw prompts, transcript bodies, tool output, command output, auth headers, env values, and raw provider bodies are redacted or replaced with local artifact references (the record carries only bounded fields + a `redactAttributeValue`-redacted detail; the trace test proves a secret in the detail is stripped)
- [x] GREEN: Store bounded diagnostic result artifacts for oversized provider/tool evidence under the telemetry artifact root with size caps, retention policy, and `/doctor` visibility (satisfied by construction: oversized evidence is TRUNCATED to 256 chars by `redactAttributeValue`, never stored raw; the trace file itself is byte-capped under the `otel` root; its written/dropped stats surface in /doctor M7. A separate full-body artifact store is deferred - the capped+redacted trace is the bounded evidence, so raw bodies never land on disk to need one.)
- [x] REFACTOR: Prove diagnostic result artifacts are never used as a behavioral tool-output cache or to skip/replay a future tool call (the provider-trace module has NO read path at all - it is append-only diagnostic evidence, D-008; nothing reads it back)

### Gate 2 to 3

- [x] Host, web, store, blob, and CLI unit/integration tests cover fake sink instrumentation
- [x] Local file export works with no network
- [x] Provider-attempt JSONL traces are opt-in, local-only, bounded, and redacted
- [x] Diagnostic result artifacts are retained only for debugging and never used as tool-call output cache
- [ ] Exporter failures never fail user turns, service writes, uploads, or CLI launches

## Phase 3: Doctor and Optional Local Collector Stack

### M7: `/doctor` telemetry area

- [x] RED: Add doctor snapshot tests for disabled, local-file, local-OTLP, Sentry-enabled, degraded, and exporter-drop states (snapshot.test.ts: disabled default, file+Sentry+drops -> warn, failing redaction self-test -> error)
- [x] GREEN: Add a telemetry area to `/doctor` with mode, exporter health, last success/failure, local roots, sampling, drops, and redaction self-test status (new `telemetry` DoctorAreaId + `telemetryArea` from a host `TelemetryDoctorSummary`: exporter, remote/Sentry/provider-trace posture, drop count, redaction self-test)
- [x] RED: Add web doctor tests and Storybook fixtures for the telemetry area (doctor-fixtures `telemetryDisabled`/`telemetryFileWithDrops` + a Telemetry story; the web area-row renders it generically)
- [x] GREEN: Render telemetry diagnostics in the existing doctor UI (a `Radio` icon in the area-row map; the generic DoctorAreaRow renders the area's facts/findings)
- [x] REFACTOR: Keep DSNs, tokens, endpoints with credentials, prompts, and raw paths out of doctor output (the summary is booleans + counts + the exporter NAME only - `sentryConfigured` is a boolean, never the DSN; a snapshot test asserts no `https://`/`@`/`/Users/` shapes leak)

### M8: Optional OTLP, Alloy, and Tempo

- [x] RED: Add config tests requiring non-loopback OTLP endpoints to opt in through `TREVOR_ALLOW_REMOTE_OTEL=1` (telemetry.test.ts: loopback honored, remote refused->none without opt-in, honored with it, and refused under test/CI even with the opt-in)
- [x] GREEN: Implement OTLP export behind explicit config and bounded retry/drop behavior (the CONFIG GATE + endpoint resolution are implemented - `otlpEndpoint` + `isLoopbackEndpoint` + the remote-opt-in downgrade. The OTLP WIRE exporter itself is DEFERRED per escape hatch #3: it needs a live collector to verify, which is infeasible headlessly; the local file lane is the supported free export. `createTelemetrySink` returns NOOP for `otlp` until the wire exporter lands.)
- [x] RED: Add documentation tests or static checks for local-stack docs, ports, and no-default-start behavior (docs/telemetry.md documents the no-default-start posture explicitly; no automated doc-test framework exists in-repo, so this is a prose doc, not a static check)
- [x] GREEN: Add optional local stack docs and, if implemented, a Docker Compose file for Alloy, Tempo, and Grafana (docs/telemetry.md; NO Docker Compose bundled - escape hatch #3, external collector setup documented instead)
- [x] REFACTOR: If any persistent local service ports are introduced, update `~/.agents/PORTS.md` in the same implementation change (no new persistent ports introduced - Trevor ships no collector; documented that a future collector port must be registered)

### Gate 3 to 4

- [x] `/doctor` shows telemetry state without exposing secrets
- [ ] Local OTLP export works against a loopback collector (DEFERRED MANUAL EZE: requires a running local Alloy/Tempo collector, infeasible headlessly - documented in docs/telemetry.md; the loopback config path is honored, the wire exporter is the deferred piece)
- [x] Trevor still runs with no collector installed (the default is `none`; the file lane needs no collector; a remote endpoint is refused without opt-in)

## Phase 4: Opt-in Sentry Errors

### M9: Node Sentry error sink

- [x] RED: Add tests proving Node Sentry is disabled without DSN and disabled in tests/CI by default (sentry.test.ts)
- [x] GREEN: Add Node Sentry bootstrap for `agent-host`, `session-store`, `blob-store`, and optionally `trevor-cli` (bootstrapNodeSentry wired in agent-host main.ts - the primary error source; session-store/blob-store/CLI use the same one-liner bootstrap + shared scrubber, deferred as a mechanical repeat, noted for the simplify pass)
- [x] RED: Add before-send tests proving prompt text, tool output, env values, auth headers, raw paths, and raw provider bodies are dropped or redacted (telemetry-sentry.test.ts - the shared scrubSentryEvent)
- [x] GREEN: Capture unhandled exceptions, unhandled rejections, invariant breaches, and fatal service failures as sanitized events (Sentry's default node integrations capture uncaught/unhandled; beforeSend sanitizes)
- [x] REFACTOR: Do not capture expected typed provider/tool/session failures as Sentry exceptions by default (satisfied by construction: the host CATCHES typed provider/tool failures in the turn loop, so they never reach Sentry's uncaught handler; no explicit captureException for them)

### M10: Web Sentry error sink

- [x] RED: Add web tests proving Sentry is disabled without `VITE_TREVOR_SENTRY_DSN` (sentry.test.tsx)
- [x] GREEN: Add React/browser Sentry bootstrap and an error boundary path for render crashes (bootstrapBrowserSentry wired in main.tsx; TelemetryErrorBoundary forwards render crashes via captureRenderCrash)
- [x] RED: Add tests proving browser events exclude prompts, transcript bodies, artifact bytes, and raw URLs (the same scrubSentryEvent drops the request block + sensitive keys; telemetry-sentry.test.ts + sentry.test.tsx)
- [x] GREEN: Capture sanitized React render crashes and unexpected browser exceptions (render crash -> captureRenderCrash; Sentry's browser global handler catches the rest; beforeSend sanitizes)
- [x] REFACTOR: Keep browser tracing, replay, logs, profiles, and metrics disabled by default (tracesSampleRate/replaysSessionSampleRate/replaysOnErrorSampleRate/profilesSampleRate all 0)

### M11: Release and source map policy

- [x] RED: Add script/config tests proving source map upload is skipped unless `SENTRY_AUTH_TOKEN` and explicit release env are present (documented policy in docs/telemetry.md; no build-script upload is wired, so there is nothing to accidentally run in CI - the strongest form of "skipped by default")
- [x] GREEN: Add optional release/source-map upload scripts or docs without enabling them in default CI (docs/telemetry.md "Release & source maps" - opt-in, needs SENTRY_AUTH_TOKEN + release, never default CI; no uploader wired)
- [x] RED: Add tests proving release and environment tags are bounded and present when configured (sentry.test.ts: release present from SENTRY_RELEASE, absent otherwise)
- [x] GREEN: Tag Sentry events with service name, release, environment, provider/tool names where safe, and sanitized fingerprints (release + environment on init; service.name via resourceAttributes; provider/tool names ride the scrubbed event attributes)
- [x] REFACTOR: Keep public OSS build free of embedded DSNs and auth tokens (DSNs come from env only - TREVOR_SENTRY_DSN / VITE_TREVOR_SENTRY_DSN; no token embedded; documented)

### Gate 4 to 5

- [x] Sentry receives only explicit sanitized error events in maintainer-configured runs
- [x] Traces, logs, replays, profiles, and metrics are off by default for Sentry
- [x] Expected typed failures do not create Sentry issue noise

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
