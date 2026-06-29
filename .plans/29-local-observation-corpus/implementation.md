# Local Observation Corpus - Implementation Plan

## 0. Hard Dependencies

- [ ] `03-filesystem-root-taxonomy` - storage-root policy must be the source of truth before expanding observation persistence.
- [x] `.plans/trevor-v2` D-076-D-079 provider-outage recovery - existing provider observations are the first producer to migrate.
- [x] `apps/agent-host/src/paths.ts` exposes `TREVOR_STATE_HOME` - diagnostic state already has an XDG-backed root.

## 1. Architecture

Trevor already records one narrow observation type: unknown provider failure shapes are redacted, fingerprinted, deduped, and stored by `apps/agent-host/src/providers/observation-store.ts`. That current implementation writes to `<TREVOR_HOME>/provider-observations.json`, which conflicts with the repository storage taxonomy. The broader observation corpus belongs under diagnostic state:

```text
${XDG_STATE_HOME:-~/.local/state}/trevorV2/observations/
```

The corpus is local diagnostic evidence, not durable user configuration. It captures redacted patterns Trevor has seen so `/doctor`, debug exports, tests, and later offline classifier-improvement workflows can explain what happened without raw prompts, secrets, provider payloads, tool outputs, or auth material.

### Key Constraints

| Constraint | Impact |
|---|---|
| Use `TREVOR_STATE_HOME`, not `TREVOR_HOME` | Observations are append/debug state, not user settings or durable product data. |
| Diagnostic-only first | The corpus records evidence but does not change model prompts, routing, retries, or tool behavior. |
| Redacted and shape-oriented | Store stable shape fields, fingerprints, counts, and sanitized skeletons, never raw payloads. |
| Best-effort writes | Observation persistence must never fail a user turn. |
| Inspectable and removable | Users need doctor/CLI/export/delete paths before the corpus grows. |
| Future classifier use is gated | Any runtime behavior or classifier update consumption needs a later explicit plan decision. |

### Boundaries

- **Observation store:** owns storage path, schema version, append/dedupe mechanics, redaction, retention helpers, and migration from the existing provider-observations file.
- **Producer adapters:** provider failure recording first; later tool/result/loop/harness producers call the same narrow write API.
- **Doctor/debug surfaces:** read summaries and top fingerprints only; detailed inspection requires explicit export/view commands.
- **Classifier tooling:** later offline consumer only. No automatic prompt injection or runtime classifier mutation in this plan.
- **Session log:** observations are not Trevor events and are not appended to Richter/session-store logs by default.

### Storage Shape

Near-term target:

```text
${TREVOR_STATE_HOME}/observations/
  provider-failures.jsonl
  index.json
```

Later producer files may be added under the same directory:

```text
tool-patterns.jsonl
loop-patterns.jsonl
harness-guidance.jsonl
```

Records should share a common envelope:

```json
{
  "schemaVersion": 1,
  "id": "obs_...",
  "kind": "provider_failure",
  "fingerprint": "abcd1234ef567890",
  "firstSeen": "2026-06-28T00:00:00.000Z",
  "lastSeen": "2026-06-28T00:05:00.000Z",
  "count": 2,
  "redactionVersion": 1,
  "source": {
    "provider": "deepseek",
    "model": "deepseek-pro",
    "phase": "model-step"
  },
  "shape": {
    "classification": "unknown",
    "retryable": false,
    "status": 502,
    "code": "ECONNRESET",
    "messageSkeleton": "connection reset before response",
    "fieldNames": ["error", "status"]
  }
}
```

### Observability

- `/doctor` reports corpus path health, record counts, unknown counts, last write result, and top fingerprints by count.
- Debug export includes a redacted corpus bundle with schema version and producer counts.
- Store writes emit structured debug logs with kind, fingerprint, outcome, and redacted reason on failure.
- A corruption/migration failure is visible in `/doctor` but never blocks turns.

## 2. Phases

### Phase 1: Storage Correction and Migration

**Goal:** Move the existing provider observation store from `TREVOR_HOME` to `TREVOR_STATE_HOME` without losing diagnostic value.

**Gate from previous:** D-076 provider observation code exists.

#### M1: Path Ownership and Migration

- **Dependencies:** hard dependencies
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving observation paths resolve under `TREVOR_STATE_HOME/observations`, including `XDG_STATE_HOME` overrides.
  2. GREEN: Replace the provider observation path owner with the shared `TREVOR_STATE_HOME` constant.
  3. RED: Add migration tests for an existing `<TREVOR_HOME>/provider-observations.json` file.
  4. GREEN: Import or convert the old file into the new state-root corpus, preserving fingerprints/counts.
  5. REFACTOR: Remove duplicated home resolution from the provider observation store.

#### M2: Common Observation Envelope

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add schema tests for a versioned observation envelope shared by provider and future producers.
  2. GREEN: Implement the common envelope and provider-failure adapter.
  3. RED: Add tests for redaction version, kind-specific payload validation, and corrupt-record tolerance.
  4. GREEN: Decode valid records defensively and ignore invalid lines with a visible diagnostic summary.
  5. REFACTOR: Keep provider-specific fields under a `shape`/`source` payload instead of top-level drift.

#### M3: Append, Dedupe, and Retention Mechanics

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for append-only writes plus stable fingerprint dedupe into an index.
  2. GREEN: Implement append and index update so repeated shapes increment count/lastSeen.
  3. RED: Add tests for write failure, corrupt index, concurrent writes, and large corpus behavior.
  4. GREEN: Make writes best-effort and index repairable from JSONL when needed.
  5. REFACTOR: Isolate filesystem persistence from observation normalization and fingerprinting.

### Phase 2: Consumers and Control Surfaces

**Goal:** Make the corpus inspectable and removable before adding more producers.

**Gate from previous:** provider failures write to the new corpus.

#### M4: Doctor and Debug Summary

- **Dependencies:** M1-M3
- **Effort:** M
- **Tasks:**
  1. RED: Add `/doctor` snapshot tests for corpus path, writeability, counts, unknown count, and top fingerprints.
  2. GREEN: Update live doctor assembly to read the new observation summary.
  3. RED: Add tests proving `/doctor` never displays raw messages, auth values, prompts, or payload bodies.
  4. GREEN: Surface only counts, fingerprints, producer kinds, and sanitized statuses.
  5. REFACTOR: Keep provider-failure log summaries distinct from observation-corpus summaries.

#### M5: Inspect, Export, and Delete

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add CLI or command tests for listing observation summaries and exporting redacted records.
  2. GREEN: Implement explicit inspect/export command paths over the corpus.
  3. RED: Add tests for deleting the corpus or deleting by kind/fingerprint.
  4. GREEN: Implement removal with confirmation where interactive surfaces require it.
  5. REFACTOR: Document privacy boundaries and the exact fields that may be exported.

### Phase 3: Additional Producers Without Runtime Consumption

**Goal:** Add observation producers only where the schema and controls can support them.

**Gate from previous:** corpus is inspectable, exportable, and deletable.

#### M6: Provider Failure Producer Hardening

- **Dependencies:** M1-M5
- **Effort:** S
- **Tasks:**
  1. RED: Add tests for unknown, low-confidence, retry-exhausted, and non-retryable provider observations.
  2. GREEN: Normalize provider failure producer calls into the common observation API.
  3. RED: Add tests proving known/actionable auth, quota, and context-overflow failures do not spam the corpus.
  4. GREEN: Record only useful classifier-gap evidence with stable fingerprints.
  5. REFACTOR: Share fingerprint logic with provider-failure debug logging where correlation is useful.

#### M7: Later Producer Hooks

- **Dependencies:** M1-M6
- **Effort:** M
- **Tasks:**
  1. RED: Add disabled-by-default tests or fixtures for tool-pattern, loop-pattern, and harness-guidance observation kinds.
  2. GREEN: Add schema support for those kinds without wiring automatic producers yet.
  3. RED: Add tests proving raw tool outputs, full prompts, and transcript text are rejected or redacted.
  4. GREEN: Provide narrow producer APIs that accept only shape summaries.
  5. REFACTOR: Keep every new producer opt-in until a concrete plan authorizes it.

#### M8: Classifier Consumption Gate

- **Dependencies:** M1-M7
- **Effort:** S
- **Tasks:**
  1. RED: Add tests proving observation records are never injected into model prompts or history projection.
  2. GREEN: Keep corpus reads limited to doctor/debug/export surfaces in this plan.
  3. RED: Add tests proving classifier rules are not mutated at runtime from observation data.
  4. GREEN: Document future classifier-improvement workflow as offline/manual unless a later plan changes it.
  5. REFACTOR: Add clear code comments around the non-consumption boundary.

### Phase 4: Verification

**Goal:** Validate storage, privacy, migration, and user-facing diagnostics.

**Gate from previous:** M1-M8 pass.

#### M9: End-to-End Verification

- **Dependencies:** M1-M8
- **Effort:** M
- **Tasks:**
  1. RED: Add integration test that triggers an unknown provider failure and verifies a redacted state-root observation.
  2. GREEN: Make the full path pass through provider failure handling, corpus write, and doctor summary.
  3. RED: Add migration smoke test from old TREVOR_HOME provider-observations file to new XDG state file.
  4. GREEN: Verify old and new installations converge on the new corpus path.
  5. REFACTOR: Update docs and AGENTS guidance references that still say provider observations live under `TREVOR_HOME`.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---:|---:|---|---|
| Corpus stores sensitive raw data | high | medium | Redaction at API boundary, shape-only schema, tests for prompts/keys/raw payload rejection. | Host |
| Diagnostic corpus starts influencing runtime behavior too early | high | medium | Explicit non-consumption tests and a future classifier gate. | Host |
| Migration loses existing provider observations | medium | low | Preserve old file until successful import and test count/fingerprint equivalence. | Host |
| JSONL/index drift creates false summaries | medium | medium | Index repair from JSONL and corrupt-record diagnostics in `/doctor`. | Host |
| Storage taxonomy drifts again | medium | low | Import `TREVOR_STATE_HOME` from `paths.ts`; no duplicate home resolution. | Host |

## 4. Escape Hatches

1. **If index repair is too much for the first cut:** use one compact JSON file under `TREVOR_STATE_HOME/observations/provider-failures.json` and defer JSONL until producer volume justifies it.
2. **If migration risks data loss:** leave the old file untouched, copy into the new corpus, and show a doctor warning if both roots contain records.
3. **If broader producer schemas are not ready:** ship provider-failure migration plus inspect/export/delete only; keep tool/loop/harness kinds as deferred schema fixtures.

## 5. Progress Report Accounting

The progress report is `.plans/29-local-observation-corpus/progress-report.md`. It tracks the current implementation cutoff for moving provider observations to XDG diagnostic state and establishing the corpus boundary. Future classifier behavior is intentionally excluded from current runtime scope.

Before implementation resumes, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "29-local-observation-corpus"
```

## 6. Validation Commands

```bash
pnpm --filter @trevor/agent-host test
pnpm --filter @trevor/agent-host typecheck
pnpm test
pnpm typecheck
```

## 7. Decisions

Canonical decisions are in `.plans/29-local-observation-corpus/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "29-local-observation-corpus"
```
