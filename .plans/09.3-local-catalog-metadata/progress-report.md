# Local Catalog Metadata - Progress Report

## Summary

- **Current focus:** M1 - Local Fetch via `/api/v0/models`
- **Completed:** 4 / 37
- **Current cutoff blockers:** 33
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

- [ ] RED: Add a test where a fake LM Studio `/api/v0/models` returns two same-id quants; assert the local fetch yields enriched models carrying `quantization`, `type`, `arch`, `max_context_length`, and `capabilities`.
- [ ] GREEN: Extend the local branch of `fetchSourceModels`/`LiveModel` to query `/api/v0/models` and map the native fields; keep cloud/gateway/api-key sources on `/v1/models`.
- [ ] RED: Add tests for degradation - `/api/v0` unreachable, non-OK, or missing fields - asserting an id-only entry plus `stale`, never a dropped model.
- [ ] GREEN: Implement the id-only fallback and stale marking on the local path.
- [ ] REFACTOR: Factor a shared native-record parser used by both `fetchSourceModels` and `LmStudioClient.fetchModelInfo()` so `/api/v0` is parsed in one place.

#### M2: Extend `CatalogEntry` with Quantization + Arch

- [ ] RED: Add contract tests that `CatalogEntry` carries optional `quantization` and `arch`, that they decode/round-trip, and that send-time model metadata preserves them.
- [ ] GREEN: Add the optional fields to `CatalogEntry` in `packages/session/src/model-source.ts` and thread them through `entryFor`.
- [ ] RED: Add tests proving cloud entries leave `quantization`/`arch` absent (no regression to the cloud path).
- [ ] GREEN: Populate the new fields only for local entries.
- [ ] REFACTOR: Keep the read-model change additive and backward-compatible for existing decoders.

#### Gate 1-2

- [ ] The local catalog fetch reads `/api/v0/models` and surfaces quantization/type/arch/context/capabilities.
- [ ] `/api/v0` failure degrades to id-only + stale, never an empty or dropped local model.
- [ ] `CatalogEntry` carries optional quantization/arch; cloud entries are unaffected.

### Phase 2: Live Capability Derivation

#### M3: Derive Capabilities, Vision, and Context for Local

- [ ] RED: Add tests asserting a local VLM (`type: "vlm"`) gets a `vision` capability; a model whose `capabilities` lacks `tool_use` does NOT get `tools`; tools/reasoning reflect the native record.
- [ ] GREEN: In `entryFor`, derive `capabilities` and `vision` for local entries from the native `capabilities`/`type` instead of the hardcoded `["tools"]` + cloud-only `input` lookup.
- [ ] RED: Add a test that a local entry's `contextLength` comes from native `max_context_length`, still overridable by `models.json` via `resolveContextWindow`.
- [ ] GREEN: Source local `contextLength` from the native record while preserving the override precedence.
- [ ] REFACTOR: Separate the local vs cloud capability-derivation paths cleanly so neither hardcodes the other's assumptions.

#### Gate 2-3

- [ ] Local capability chips reflect the runtime's real `capabilities`/`type`.
- [ ] Local VLMs show Vision; non-tool local models do not show Tools.
- [ ] Local context length comes from the native record, override precedence intact.

### Phase 3: Chooser Display and Verification

#### M4: Disambiguating Display

- [ ] RED: Add Storybook/web tests where two same-id local models render distinctly with quantization (and context), e.g. `qwen3.6-27b-mlx · 8bit · 256k` vs `· 4bit · 64k`.
- [ ] GREEN: Render quantization + context alongside the id in `model-chooser.tsx`, using existing label/Badge patterns.
- [ ] RED: Add tests proving the existing capability filters (tools/vision/reasoning) now match the live local capabilities.
- [ ] GREEN: Wire the capability/Vision chips to the live `capabilities`.
- [ ] REFACTOR: Reuse existing chooser presentation; introduce no new card layout.

#### M5: End-to-End and Degradation Verification

- [ ] RED: Add an integration/e2e test where a fake LM Studio `/api/v0` makes the catalog show quant + live caps, and a `/api/v0`-down run falls back to id-only with the source marked stale.
- [ ] GREEN: Make both scenarios pass through the real catalog load path.
- [ ] REFACTOR: Provide a shared fixture for the native model record reused by unit, web, and e2e tests.

#### Done Gate

- [ ] Unit, web, and integration/e2e tests pass for the local catalog metadata path.
- [ ] The two `qwen3.6-27b-mlx` quants are visually distinguishable in the chooser.
- [ ] Local capability/Vision/context reflect the runtime; cloud sources are unchanged.
- [ ] `/api/v0` failure degrades gracefully (id-only + stale).

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.
