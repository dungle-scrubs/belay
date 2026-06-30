# Local Catalog Metadata - Progress Report

## Summary

- **Current focus:** Complete - all milestones implemented and verified
- **Completed:** 37 / 37
- **Current cutoff blockers:** 0
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0

## 0. Hard Dependencies

- [x] D-065 model source + catalog read model is shipped: `packages/session/src/model-source.ts`, `apps/agent-host/src/providers/catalog.ts`, `source-models.ts`, `apps/web/src/components/chooser/model-chooser.tsx`.
- [x] LM Studio exposes a native `/api/v0/models` endpoint with `quantization`, `type`, `arch`, `max_context_length`, `capabilities`; `LmStudioClient.fetchModelInfo()` already reads it for the active model.
- [x] The catalog's local fetch today queries OpenAI `/v1/models` (id-only) via `DEFAULT_LMSTUDIO_URL`.
- [x] No numbered plan owns the catalog (D-065 umbrella); this plan edits shipped code directly with no numbered hard dependency.

## Current Cutoff Blockers

### Phase 1: Native Metadata Fetch and Read Model

#### M1: Local Fetch via `/api/v0/models`

- [x] RED: Add a test where a fake LM Studio `/api/v0/models` returns two same-id quants; assert the local fetch yields enriched models carrying `quantization`, `type`, `arch`, `max_context_length`, and `capabilities`.
- [x] GREEN: Extend the local branch of `fetchSourceModels`/`LiveModel` to query `/api/v0/models` and map the native fields; keep cloud/gateway/api-key sources on `/v1/models`.
- [x] RED: Add tests for degradation - `/api/v0` unreachable, non-OK, or missing fields - asserting an id-only entry plus `stale`, never a dropped model.
- [x] GREEN: Implement the id-only fallback and stale marking on the local path.
- [x] REFACTOR: Factor a shared native-record parser used by both `fetchSourceModels` and `LmStudioClient.fetchModelInfo()` so `/api/v0` is parsed in one place.

#### M2: Extend `CatalogEntry` with Quantization + Arch

- [x] RED: Add contract tests that `CatalogEntry` carries optional `quantization` and `arch`, that they decode/round-trip, and that send-time model metadata preserves them.
- [x] GREEN: Add the optional fields to `CatalogEntry` in `packages/session/src/model-source.ts` and thread them through `entryFor`.
- [x] RED: Add tests proving cloud entries leave `quantization`/`arch` absent (no regression to the cloud path).
- [x] GREEN: Populate the new fields only for local entries.
- [x] REFACTOR: Keep the read-model change additive and backward-compatible for existing decoders.

#### Gate 1-2

- [x] The local catalog fetch reads `/api/v0/models` and surfaces quantization/type/arch/context/capabilities.
- [x] `/api/v0` failure degrades to id-only + stale, never an empty or dropped local model.
- [x] `CatalogEntry` carries optional quantization/arch; cloud entries are unaffected.

### Phase 2: Live Capability Derivation

#### M3: Derive Capabilities, Vision, and Context for Local

- [x] RED: Add tests asserting a local VLM (`type: "vlm"`) gets a `vision` capability; a model whose `capabilities` lacks `tool_use` does NOT get `tools`; tools/reasoning reflect the native record.
- [x] GREEN: In `entryFor`, derive `capabilities` and `vision` for local entries from the native `capabilities`/`type` instead of the hardcoded `["tools"]` + cloud-only `input` lookup.
- [x] RED: Add a test that a local entry's `contextLength` comes from native `max_context_length`, still overridable by `models.json` via `resolveContextWindow`.
- [x] GREEN: Source local `contextLength` from the native record while preserving the override precedence.
- [x] REFACTOR: Separate the local vs cloud capability-derivation paths cleanly so neither hardcodes the other's assumptions.

#### Gate 2-3

- [x] Local capability chips reflect the runtime's real `capabilities`/`type`.
- [x] Local VLMs show Vision; non-tool local models do not show Tools.
- [x] Local context length comes from the native record, override precedence intact.

### Phase 3: Chooser Display and Verification

#### M4: Disambiguating Display

- [x] RED: Add Storybook/web tests where two same-id local models render distinctly with quantization (and context), e.g. `qwen3.6-27b-mlx · 8bit · 256k` vs `· 4bit · 64k`.
- [x] GREEN: Render quantization + context alongside the id in `model-chooser.tsx`, using existing label/Badge patterns.
- [x] RED: Add tests proving the existing capability filters (tools/vision/reasoning) now match the live local capabilities.
- [x] GREEN: Wire the capability/Vision chips to the live `capabilities`.
- [x] REFACTOR: Reuse existing chooser presentation; introduce no new card layout.

#### M5: End-to-End and Degradation Verification

- [x] RED: Add an integration/e2e test where a fake LM Studio `/api/v0` makes the catalog show quant + live caps, and a `/api/v0`-down run falls back to id-only with the source marked stale.
- [x] GREEN: Make both scenarios pass through the real catalog load path.
- [x] REFACTOR: Provide a shared fixture for the native model record reused by unit, web, and e2e tests.

#### Done Gate

- [x] Unit, web, and integration/e2e tests pass for the local catalog metadata path.
- [x] The two `qwen3.6-27b-mlx` quants are visually distinguishable in the chooser.
- [x] Local capability/Vision/context reflect the runtime; cloud sources are unchanged.
- [x] `/api/v0` failure degrades gracefully (id-only + stale).

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.
