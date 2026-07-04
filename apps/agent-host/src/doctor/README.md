# Doctor - Trevor's health surface

`/doctor` is Trevor's user-facing health report about **Trevor itself**: what is
healthy, what is degraded, what is broken, why it matters, and what to do next.
It is deliberately separate from `host.debugInfo` (see below).

## Reading the output

The default `/doctor` renders a **dashboard** in the transcript: a summary strip
(overall status + four count buckets) over a single divided list of area rows.

- Healthy areas rest as one quiet line each.
- Warnings and errors expand inline with their findings and a next action, so a
  problem is never hidden. The "Issues only" filter keeps exactly the warn/error
  areas - it can never hide a warning or an error.
- Each finding carries a title, a one-line verdict, an optional source path, an
  optional collapsed **Evidence** block (raw-but-sanitized internals), and a
  **next action** (repair guidance only - `/doctor` never performs the repair).

The overall status rolls up worst-wins across the fourteen areas: any error wins,
then any warning, then ok; an all-unchecked snapshot stays "not checked".

## The fourteen areas

Core · Session / Run · Providers / Models / Auth · Internet · Tools / Search ·
Web / Docs · MCP · LSP · Hooks · Storage / Roots · Workspace · Local admission ·
Telemetry · Updates / Version.

The canonical id set and order are frozen in `packages/session/src/doctor.ts`
(`DOCTOR_AREA_ORDER`) and pinned by `doctor.test.ts`. An area Trevor does not
probe reports `not_checked` with a concise reason - it is never dropped, so the
grid is always complete.

## Command variants

| Command | Effect |
|---|---|
| `/doctor` | Default structured dashboard snapshot. |
| `/doctor full` / `detail` / `details` | Same structured snapshot (dashboard). |
| `/doctor json` | Same structured snapshot (the web can also toggle a raw JSON view). |
| `/doctor text` / `plain` | Legacy plaintext dump for terminals / no-dashboard clients. |
| `/doctor refresh` / `recheck` | Re-probe flag (combines with any view). |
| `/doctor copy` | Copy flag (combines with any view). |

Parsing is lenient: tokens are case-insensitive, unknown tokens are ignored, and
the last view token wins. `/doctor` is a **host-owned immediate command**: it does
not start a model turn and stays available when the model/provider path is
unhealthy.

The panel also exposes **Refresh**, **Copy report**, and **View JSON** actions;
copy and JSON act on the already-sanitized snapshot the host published, so neither
can leak anything the dashboard does not already show.

## Guarantees

- **Bounded** - every live probe is time-limited. Provider readiness is raced
  against a per-probe timeout; the standalone runner (`probe-runner.ts`) caps each
  check and an overall budget. A slow or wedged check degrades to `not_checked`
  with a re-run action instead of hanging the command.
- **Non-mutating** - a health probe never changes state: no writes, no model load,
  no warm, no eviction. `/doctor` reads `readiness()` only, so running it can never
  alter provider, workspace, or storage state. (Pinned by
  `doctor/build.test.ts` and `doctor/probe-runner.test.ts`.)
- **Redacted** - findings and evidence carry only sanitized facts: booleans,
  counts, enums, home-abbreviated paths, and already-redacted one-liners. No keys,
  DSNs, endpoints, prompts, request bodies, or raw environment ever appear. The
  copy report and the model-facing tool render a **text projection** of that same
  sanitized snapshot, never the raw object.

## Model-facing `doctor` tool

The read-only `doctor` tool returns the same sanitized health report as formatted
text. It is **diagnostic only**: the system prompt tells the model to call it only
when the user asks about Trevor's own health, setup, provider/model/tool
availability, connectivity, or why a turn failed - never as routine
context-gathering for ordinary coding work (use read/grep/glob for that).

## Doctor vs `host.debugInfo`

- **Doctor** = structured health, evidence, and repair guidance for the operator.
- **`host.debugInfo`** = sanitized runtime internals for inspection.

Reach for `host.debugInfo` when you need raw internal state a health verdict does
not surface; reach for `/doctor` to answer "is Trevor healthy, and if not, what do
I do?".
