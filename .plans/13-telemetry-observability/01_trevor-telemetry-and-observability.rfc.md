---
number: 01
title: "Trevor Telemetry and Observability"
type: feature
status: Draft
author: Kevin
date: 2026-06-27
---

# RFC-01: Trevor Telemetry and Observability

## Abstract

Trevor needs a coherent observability layer that helps diagnose host, web, store, blob, and launcher failures without turning local development into a paid telemetry stream. This RFC specifies an OTel-first, local/free-by-default design with Sentry as an optional sanitized error inbox, not the primary telemetry backend. Broad traces, metrics, debug artifacts, and service logs stay local under the Trevor state root or flow to an optional local collector stack. The design also corrects current diagnostic-log drift away from `TREVOR_HOME`, which is not the right home for machine diagnostic streams.

## Introduction

Trevor V2 already has structured host logs, typed failures, `/doctor`, provider failure observations, turn-stop JSONL metrics, and a durable session event log. Those surfaces are useful, but they are not one coherent telemetry system. The immediate pressure is to add Sentry for host and web errors while avoiding two traps: sending all OpenTelemetry data to Sentry, which creates cost, and putting diagnostic artifacts under `TREVOR_HOME`, which the project taxonomy reserves for user configuration and durable Trevor state.

This RFC covers:

- process-level error capture for `apps/web`, `apps/agent-host`, `apps/session-store`, `apps/blob-store`, and optionally `apps/trevor-cli`
- OpenTelemetry-style instrumentation for traces, spans, and low-cardinality metrics
- local/free export modes using `TREVOR_STATE_HOME`
- optional Sentry error reporting for the maintainer's local use
- optional local collector tooling using Alloy and Tempo
- redaction, sampling, cardinality, and cost controls

This RFC does not cover:

- using Sentry as Trevor's full trace, metrics, log, replay, or profiling backend
- sending prompt text, transcript bodies, raw tool output, raw command output, env values, auth headers, or file contents to any remote backend
- replacing the durable Richter/session-store log as product truth
- replacing `/doctor` as the user-visible local health surface
- self-hosting Sentry

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

- **Telemetry:** Machine-readable diagnostic data emitted by Trevor runtime surfaces. This includes errors, spans, metrics, logs, and local artifacts.
- **Error event:** A discrete report of an unexpected exception, invariant breach, unhandled rejection, React render crash, or fatal service failure.
- **Expected failure:** A typed failure that is part of normal Trevor operation, such as provider overload, auth needed, context pressure, a tool validation error, or a network outage classified by Trevor. Expected failures SHOULD be represented as logs, spans, metrics, or `/doctor` findings, not remote Sentry exceptions by default.
- **Span:** A timed operation with attributes, events, status, and optional parent/child relationships. Spans SHOULD describe public module boundaries, not every helper.
- **Metric:** A numeric measurement or aggregate, such as duration, count, queue depth, retry count, or exporter drops. Metrics MUST avoid high-cardinality labels.
- **Log stream:** Human-readable process output and structured boundary log lines. Detached process logs belong under the local state root.
- **Local artifact:** JSONL, OTLP JSON, snapshots, or other diagnostic files written to the machine running Trevor.
- **Remote sink:** Any destination outside the local machine, including Sentry and remote OTLP endpoints.
- **Alloy:** Grafana Alloy, a local collector/agent that can receive, process, filter, batch, and export OpenTelemetry signals. It is optional.
- **Tempo:** Grafana Tempo, a trace backend used to store and query traces locally through Grafana. It is optional and receives traces from Alloy or another OTel collector.

## Motivation

The maintainer wants Sentry-style crash visibility while staying on Sentry's free tier and keeping Trevor open-source-friendly. Cost is the main design constraint: traces, spans, logs, replays, profiles, and high-volume metrics can become billable remote telemetry. Privacy is still a hard constraint because Trevor sees prompts, local paths, command output, model/provider data, and repository content.

Trevor also needs a backend-neutral instrumentation shape. OpenTelemetry gives Trevor a standard local instrumentation model while preserving the option to route data to free local tools, Sentry, or another backend later. Sentry should be one sink behind that policy, not the system that defines every diagnostic shape.

## Design

### Guiding Decisions

1. <!-- D-001 --> Trevor MUST default to no outbound telemetry.
2. <!-- D-002 --> Trevor MUST treat Sentry as opt-in error capture, not as the default OTel exporter.
3. Trevor SHOULD instrument broadly using OTel-compatible spans and metrics, but SHOULD export broadly only to local/free sinks.
4. <!-- D-004 --> Trevor MUST write diagnostic logs, traces, and metrics under `TREVOR_STATE_HOME`, not `TREVOR_HOME`.
5. <!-- D-003 --> Trevor packages MUST NOT initialize Sentry or global OTel SDKs. Applications own runtime initialization.
6. <!-- D-006 --> Trevor MUST redact before telemetry leaves the module boundary, and remote sinks MUST get an additional final redaction pass.
7. <!-- D-007 --> Trevor MUST make telemetry cost visible and bounded through defaults, sampling, caps, and `/doctor`.

### Runtime Topology

Trevor uses three layers:

1. **Shared observability contract:** A shared package or module owns telemetry vocabulary, redaction helpers, resource attributes, span names, metric names, and config parsing. It contains no process-global Sentry initialization.
2. **Runtime integrations:** Each app initializes the needed runtime integration at its process/browser boundary:
   - `apps/agent-host`
   - `apps/session-store`
   - `apps/blob-store`
   - `apps/trevor-cli`
   - `apps/web`
3. **Export sinks:** Runtime integrations export to zero or more sinks:
   - no-op sink, default
   - local file sink under `TREVOR_STATE_HOME`
   - optional local OTLP endpoint, usually Alloy or an OTel Collector
   - optional Sentry error sink

### Sentry Scope

Sentry is allowed only when explicitly configured:

- Node: `TREVOR_SENTRY_DSN` or `SENTRY_DSN`
- Web: `VITE_TREVOR_SENTRY_DSN`
- optional override: `TREVOR_TELEMETRY_REMOTE=1`

Sentry MUST be disabled by default in OSS checkout, tests, CI, Storybook, and any process without a configured DSN.

Sentry defaults:

- error capture: enabled only when DSN is configured
- traces: disabled by default
- logs: disabled by default
- replay: disabled by default
- profiling: disabled by default
- metrics: disabled by default
- attachments: disabled by default
- source map upload: optional, manual, never required for normal local use

<!-- D-003 --> Sentry SHOULD use two projects when enabled:

- `trevor-web` for browser errors
- `trevor-node` for `agent-host`, `session-store`, `blob-store`, and optional `trevor-cli`, separated by `service.name`

Trevor packages MUST NOT create separate Sentry projects and MUST NOT call `Sentry.init`.

### OpenTelemetry Scope

Trevor SHOULD instrument these public boundaries:

- host turn lifecycle: turn start, model step, tool batch, provider stream, cancellation, terminal stop cause
- provider boundaries: LM Studio, pi-ai/Codex, model load/readiness probes, retry/reconnect classification
- tool boundaries: read, write, edit, bash, process, web search/fetch, future MCP/LSP tools
- session transport: publish, replay, tail, reconnect, presence, inventory
- blob-store: upload, normalize, hash, fetch, reject by size/type
- session-store: append, replay, WS connect, inventory, SQLite write/read failures
- web: session connect, publish, artifact upload, transcript render crash, provider/model chooser data failures
- CLI: launch, service readiness, host spawn/reuse, browser open, lifecycle commands

Trevor SHOULD NOT span internal helpers unless they are stable module boundaries. This keeps traces useful through refactors.

### Free Local Export

The default local modes are:

- `TREVOR_OTEL_EXPORTER=none`: no-op, default
- `TREVOR_OTEL_EXPORTER=file`: write bounded JSONL or OTLP JSON files under `TREVOR_STATE_HOME/otel`
- `TREVOR_OTEL_EXPORTER=otlp`: send OTLP to an explicitly configured local endpoint

The OTLP endpoint SHOULD default to loopback only. A non-loopback OTLP endpoint MUST require an explicit override such as `TREVOR_ALLOW_REMOTE_OTEL=1`.

The local state root SHOULD hold:

- `logs/`: detached process stdout/stderr and structured log streams
- `otel/traces/`: local spans or OTLP trace files
- `otel/metrics/`: local low-cardinality metric snapshots
- `otel/exporter-drops.jsonl`: exporter errors, dropped batches, and sampling decisions
- `provider-observations.json` or successor state files once migrated from config-root drift

The cache root is only for rebuildable derived data, not durable diagnostics.

### Alloy and Tempo

<!-- D-005 --> Alloy and Tempo are optional local tooling, not Trevor runtime dependencies.

- Alloy is the local collector. It receives OTLP from Trevor, applies filtering/redaction/batching, and exports traces to Tempo or writes local files.
- Tempo is the trace store. It stores and indexes traces so Grafana can search by trace id, service name, duration, and attributes.
- Grafana is the optional UI. It queries Tempo and, later, any local metrics backend.

Trevor MUST work without Alloy, Tempo, Docker, or Grafana. A local stack MAY be added later for richer inspection, but the first-class fallback is local files and `/doctor`.

### Metrics Policy

Metrics are useful only if they stay low-cardinality and cheap.

Allowed metric labels:

- service name
- provider family
- model family or configured model id only when bounded
- tool name
- stop cause
- error code or typed failure class
- exporter name

Disallowed metric labels:

- raw prompt text
- tool arguments
- raw local file paths
- session ids in aggregate metrics
- run ids in aggregate metrics
- full provider error messages
- arbitrary URLs
- raw command strings

Run ids and session ids belong in traces and local logs, not aggregate metric labels.

### Remote Redaction

Remote sinks MUST receive a sanitized envelope:

- no prompt text
- no transcript bodies
- no raw tool output
- no raw command output
- no file contents
- no auth headers
- no API keys
- no environment values
- no full local paths unless explicitly shortened or hashed
- no raw provider response bodies

Allowed remote fields:

- service name
- release and environment
- sanitized error type and message
- stable error code or failure class
- run id and session id only if configured as safe, otherwise hashed
- provider name and bounded model id
- tool name
- durations, counts, sizes, token counts
- short fingerprints and hashes
- redacted path basename or path kind when useful

### `/doctor` Surface

`/doctor` SHOULD report:

- whether telemetry is disabled, local-only, or remote-enabled
- configured exporters and their last success/failure
- Sentry enabled/disabled by surface
- effective sampling rates
- local artifact roots
- dropped export counts
- redaction self-test status
- whether detached process logs are under local state

`/doctor` MUST NOT run unbounded export probes or leak DSNs, auth tokens, endpoint secrets, prompts, tool output, or raw paths.

## State Machine

Each runtime has a telemetry mode:

```
disabled -> local_file       (on: TREVOR_OTEL_EXPORTER=file)
disabled -> local_otlp       (on: TREVOR_OTEL_EXPORTER=otlp and endpoint valid)
disabled -> sentry_errors    (on: Sentry DSN configured)
local_file -> local_otlp     (on: endpoint configured and reachable)
local_otlp -> degraded       (on: exporter failure or timeout)
sentry_errors -> degraded    (on: Sentry init/filter/send failure)
degraded -> previous_mode    (on: next successful export)
any -> disabled              (on: explicit disable or test/CI guard)
```

Exporter failures MUST NOT fail user turns, CLI launch, web rendering, session-store appends, or blob-store reads/writes. They are diagnostic failures and should be visible in `/doctor`.

## Error Handling

- `TEL001_CONFIG_INVALID`: Telemetry config is invalid. Recovery: disable affected exporter, report in `/doctor`.
- `TEL002_REMOTE_DISABLED`: Remote sink configured without explicit remote opt-in. Recovery: keep local-only, report needed env.
- `TEL003_REDACTION_BLOCKED`: Redaction detected unsafe fields before remote send. Recovery: drop event, increment local dropped count.
- `TEL004_EXPORT_FAILED`: Local or OTLP exporter failed. Recovery: retry later with bounded backoff; never affect user work.
- `TEL005_SENTRY_DROPPED`: Sentry event dropped by policy, sampling, or before-send filter. Recovery: count locally.
- `TEL006_CARDINALITY_REJECTED`: Metric labels include disallowed high-cardinality fields. Recovery: drop metric and log a local diagnostic.
- `TEL007_STATE_WRITE_FAILED`: Local diagnostic artifact write failed. Recovery: keep process running and report in `/doctor`.
- `TEL008_SOURCE_MAP_SKIPPED`: Source map upload missing token or disabled. Recovery: skip upload; runtime error capture still works.

## Security Considerations

Telemetry crosses sensitive boundaries because Trevor operates inside local repositories, sees prompts and tool output, and calls model/provider APIs. Trevor MUST assume raw runtime data is sensitive. Redaction MUST happen before any remote send and SHOULD happen before local persistence where practical.

Remote telemetry MUST be opt-in. The OSS default MUST contain no DSN and no automatic remote endpoint. CI MUST NOT send telemetry unless explicitly configured for a private maintainer environment.

Cost control is also a safety property. Broad remote trace/log export can create unexpected bills. Trevor MUST default remote trace, log, replay, profile, and metric export to off even when Sentry error capture is enabled.

Telemetry configuration MUST NOT be injected into model prompts. Diagnostics may be shown in `/doctor` and local logs, but should not become conversational context unless a user explicitly asks for diagnostics.

## Alternatives Considered

### Send All OTel to Sentry

This is attractive because Sentry can display errors and performance data in one product. It is rejected as the default because spans, logs, metrics, profiles, and replays create cost and privacy pressure. Trevor may use Sentry for selected errors and rare sampled traces later, but not as the broad exporter.

### No Sentry

This is cheapest and simplest. It is rejected because browser and host crash grouping, issue fingerprints, and release-aware stack traces are useful for the maintainer. The compromise is opt-in error capture only.

### Self-host Sentry

This avoids SaaS bills but adds operational burden and a large dependency surface. It is out of scope.

### Local Logs Only

This preserves privacy and cost but makes time relationships across host, store, blob, CLI, and web hard to inspect. OTel spans provide a standard trace model while still allowing local-only storage.

### Tempo Without a Collector

Direct-to-Tempo export reduces moving parts, but a collector gives Trevor a clean place to filter, redact, batch, and route signals. Alloy or the OpenTelemetry Collector is the recommended local path when a collector is enabled.

## Implementation Plan

The implementation is decomposed in `implementation.md`. The high-level sequence is:

1. Establish config, storage roots, and a no-op telemetry boundary.
2. Add local OTel-compatible spans, metrics, and file export.
3. Add `/doctor` visibility for telemetry state and exporter health.
4. Add an optional local collector stack using Alloy and Tempo.
5. Add opt-in Sentry error capture for Node and web, with remote traces/logs/replays/profiles off by default.
6. Validate cost, redaction, cardinality, and failure isolation.

## Open Questions

No blocker questions remain for the first plan. Two decisions are intentionally deferred to implementation time:

1. Exact local-stack ports for Grafana, Alloy, Tempo, and OTLP loopback endpoints. These MUST be chosen from the reserved local-dev range and recorded in `~/.agents/PORTS.md` when the stack is introduced.
2. Whether source maps should be uploaded manually to Sentry for local maintainer builds. The default plan treats this as optional and disabled.

## References

### Normative

- [Trevor V2 implementation plan](../trevor-v2/implementation.md) - Canonical Trevor architecture, storage taxonomy, and current observability posture.
- [Sentry JavaScript Node OpenTelemetry docs](https://docs.sentry.io/platforms/javascript/guides/node/opentelemetry/) - Sentry's JavaScript OTel integration context.
- [Sentry JavaScript filtering docs](https://docs.sentry.io/platforms/javascript/guides/node/configuration/filtering/) - Event filtering and `beforeSend` style controls.
- [Sentry pricing](https://sentry.io/pricing/) - Event, span, replay, log, and monitor quota/cost context.
- [OpenTelemetry Collector docs](https://opentelemetry.io/docs/collector/) - Collector model for receiving, processing, and exporting telemetry.

### Informative

- [Grafana Alloy docs](https://grafana.com/docs/alloy/latest/) - Optional local collector distribution.
- [Grafana Tempo docs](https://grafana.com/docs/tempo/latest/) - Optional local distributed tracing backend.
- [Sentry React docs](https://docs.sentry.io/platforms/javascript/guides/react/) - Browser-side React error capture.
