# Telemetry & Observability

Trevor's telemetry is **OTel-first, local/free by default, and remote-opt-in**. A bare checkout, the
test suite, CI, and Storybook emit **nothing remote** without an explicit environment opt-in. Prompt
text, transcript bodies, tool/command output, env values, auth headers, API keys, raw provider bodies,
and raw filesystem paths **never** become telemetry - they are dropped by key and secret-stripped by
value at the instrumentation boundary (`@trevor/session/telemetry` `safeAttributes`).

Inspect the live posture any time with **`/doctor`** → the **Telemetry** area (mode, exporter health,
drop count, redaction self-test) - it never shows a DSN, endpoint, or path.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `TREVOR_OTEL_EXPORTER` | `none` | `none` \| `file` \| `otlp` - the local exporter. |
| `TREVOR_OTEL_ENDPOINT` | - | The OTLP collector URL (used when the exporter is `otlp`). |
| `TREVOR_ALLOW_REMOTE_OTEL` | off | Required for a **non-loopback** OTLP endpoint; without it a remote endpoint is refused (downgraded to `none`). |
| `TREVOR_TELEMETRY_REMOTE` | off | Master switch for any remote export. |
| `TREVOR_PROVIDER_TRACE` | off | Opt-in local provider-attempt JSONL trace (debugging a flaky provider). |
| `TREVOR_SENTRY_DSN` / `SENTRY_DSN` | - | Node Sentry error capture (opt-in; errors only). |
| `VITE_TREVOR_SENTRY_DSN` | - | Web Sentry error capture (opt-in; errors only). |

Under `NODE_ENV=test`, `VITEST`, or `CI`, all **remote** telemetry (Sentry + non-loopback OTLP) is
forced off regardless of the above, so the suite never reports anywhere.

## Local file lane (the free baseline)

`TREVOR_OTEL_EXPORTER=file` appends bounded, redacted JSONL spans + metrics to
`$TREVOR_STATE_HOME/otel/<service>.jsonl` (byte-capped, best-effort - a full disk never fails a turn).
Inspect it with no collector at all:

```sh
TREVOR_OTEL_EXPORTER=file trevor
tail -f "${TREVOR_STATE_HOME:-$HOME/.local/state/trevorV2}/otel/agent-host.jsonl"
```

`TREVOR_PROVIDER_TRACE=1` additionally writes `otel/provider-attempts.jsonl` (failure class, retry
state, token counts, timing, redacted detail) - append-only diagnostic evidence, never read back.

## Optional local collector stack (Alloy → Tempo → Grafana)

Trevor ships **no** collector and starts **nothing** by default; the file lane above is the baseline.
To view traces in Grafana locally, run your own OTLP-capable stack and point Trevor at its **loopback**
OTLP endpoint (no `TREVOR_ALLOW_REMOTE_OTEL` needed for loopback):

- **Grafana Alloy** - the collector/agent: receives OTLP, batches/filters, forwards to Tempo.
- **Grafana Tempo** - the trace backend: stores traces for Grafana to query.
- **Grafana** - the UI.

```sh
# after your local Alloy is listening on the default OTLP HTTP port (loopback):
TREVOR_OTEL_EXPORTER=otlp TREVOR_OTEL_ENDPOINT=http://localhost:4318 trevor
```

Sending to a **remote** collector requires the explicit `TREVOR_ALLOW_REMOTE_OTEL=1` opt-in - by
design, so a checkout never ships traces off the machine by accident.

> The OTLP wire exporter and a turnkey Docker Compose for Alloy/Tempo/Grafana are intentionally NOT
> bundled (they need a running collector to verify and add operational burden); the local file lane is
> the supported free path. If a persistent local collector port is ever introduced, register it in
> `~/.agents/PORTS.md` in the same change.

## Cost & Sentry posture

Sentry, when a DSN is configured, receives **error events only** - traces, logs, replays, profiles, and
metrics stay off. Expected typed provider/tool/session failures are **not** captured as Sentry
exceptions; only unexpected exceptions, unhandled rejections, invariant breaches, and fatal service
failures are, always sanitized.
