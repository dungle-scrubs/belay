# Local Catalog Metadata - Implementation Plan

## 0. Hard Dependencies

- [x] D-065 model source + catalog read model is shipped (umbrella decision; code is live): `packages/session/src/model-source.ts` (`CatalogEntry`, `SourceSummary`, `catalogEntryFor`), `apps/agent-host/src/providers/catalog.ts` (`entryFor`, `buildCatalogSnapshot`, `loadCatalog`), `apps/agent-host/src/providers/source-models.ts` (`fetchSourceModels`), `apps/web/src/components/chooser/model-chooser.tsx`.
- [x] LM Studio exposes a native `/api/v0/models` (and `/api/v0/models/:id`) endpoint that returns `quantization`, `type` (`vlm`/`llm`), `arch`, `max_context_length`, `loaded_context_length`, and `capabilities` (e.g. `["tool_use"]`). `LmStudioClient.fetchModelInfo()` already consumes it for the single active model.
- [x] The catalog's local fetch today queries the OpenAI `/v1/models` endpoint via `DEFAULT_LMSTUDIO_URL = "http://localhost:1234/v1"`, which returns only `{ id, object, owned_by }`.
- [x] No numbered plan owns the catalog (D-065 is the umbrella owner), so this plan edits shipped code directly and has no numbered hard dependency.

## 1. Architecture

The model catalog lists each configured source's whole model inventory, queried live from the source's `/models` endpoint. For LOCAL sources (LM Studio) that endpoint is the OpenAI-compatible `/v1/models`, which carries only the model id. So the catalog cannot show quantization, model type, real capabilities, or context for a local model - and two LM Studio quants of the same model (`unsloth/qwen3.6-27b-mlx` 8-bit vs `lmstudio-community/qwen3.6-27b-mlx` 4-bit) are indistinguishable in the chooser, differing only by org prefix. <!-- D-001 -->

The richer data already exists: LM Studio's native `/api/v0/models` returns `quantization`, `type`, `arch`, `max_context_length`, and `capabilities`. `LmStudioClient.fetchModelInfo()` reads it, but only for the single active model during a turn - not for building the catalog list. This plan routes the LOCAL catalog fetch to `/api/v0/models`, carries the new fields onto `CatalogEntry`, and derives the local capability/vision/context chips from the native record instead of the current hardcoding. <!-- D-001 --> <!-- D-003 -->

Cloud, gateway, and api-key sources are unchanged: they have no native endpoint and their `/v1/models` + pi-ai registry enrichment already works. Only the local source switches endpoints. <!-- D-005 --> If `/api/v0` is unreachable or omits a field, the entry degrades to today's id-only shape (no quant/caps) and the source is marked stale, rather than dropping the model. <!-- D-006 -->

### Key Constraints

| Constraint | Impact |
|---|---|
| LM Studio direct only | The native fetch uses LM Studio's `/api/v0` over the existing local base URL; no emberlm or other control plane is introduced. |
| Additive read-model change | New `CatalogEntry` fields (`quantization`, `arch`) are optional so the contract stays backward-compatible for cloud entries and existing decoders. |
| Local-only behavior change | Only the local (LM Studio) source switches to `/api/v0` and derives live capabilities; cloud/gateway/api-key paths are untouched. |
| Live capabilities over hardcoded | Local capability/vision chips and context come from the native record, not a fixed `["tools","reasoning"]` and not the cloud-only pi-ai `input` lookup. |
| Never empty for no reason | A local runtime without `/api/v0` still lists its models via the id-only fallback; degradation is visible (stale), not silent loss. |
| Presentation reuse | The chooser renders quant/context with existing label/Badge patterns; no new card layout. |

### Boundaries

- `apps/agent-host/src/providers/source-models.ts` owns the per-source live `/models` fetch; it gains a local branch that queries `/api/v0/models` and maps the rich fields into an enriched `LiveModel`.
- `apps/agent-host/src/providers/catalog.ts` (`entryFor`) owns mapping a `LiveModel` to a `CatalogEntry`; for local entries it derives `capabilities`/`vision`/`contextLength`/`quantization`/`arch` from the native record.
- `packages/session/src/model-source.ts` owns the `CatalogEntry` read-model shape (the new optional fields live here).
- `apps/web/src/components/chooser/model-chooser.tsx` owns presentation: rendering quantization + context alongside the id, and capability/Vision chips from the live `capabilities`.
- `LmStudioClient.fetchModelInfo()` stays the active-model path; this plan factors the native model-record parsing so the catalog fetch and the client share one parser rather than two readers of `/api/v0`.

### Observability

- The local fetch logs (debug) which endpoint it used and, on `/api/v0` failure, why it fell back to id-only, so a missing-quant catalog is explainable.
- The source's existing `freshness.stale` flag carries the degraded state to the UI when `/api/v0` is unreachable.
- No secrets are involved (LM Studio needs no key); the new fields are non-sensitive model facts.

## 2. Current State

`fetchSourceModels` (`source-models.ts:38-50`) fetches `${baseUrl}/models` and maps only `{ id, name? }` for every source, local included. `entryFor` (`catalog.ts:183-208`) seeds `capabilities = ["tools"]`, appends `"reasoning"` whenever `reasoningLevels.length > 1` (always true for local, since `reasoningLevelsFor` returns `["off","on"]`), and derives `"vision"` from the cloud-only pi-ai `model?.input?.includes("image")` - so every local model shows Tools + Reasoning regardless of its real capabilities, and local VLMs (`qwen3-vl-*`) never get a Vision tag. `displayName` falls back to the bare id for local. `CatalogEntry` (`model-source.ts:82-97`) has no field for quantization or arch.

## 3. Phases

### Phase 1: Native Metadata Fetch and Read Model

**Goal:** The local catalog fetch reads LM Studio's native record and the `CatalogEntry` contract can carry quantization + arch.

**Gate from previous:** Hard dependencies present.

#### M1: Local Fetch via `/api/v0/models`

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add a test where a fake LM Studio `/api/v0/models` returns two same-id quants; assert the local fetch yields enriched models carrying `quantization`, `type`, `arch`, `max_context_length`, and `capabilities`.
  2. GREEN: Extend the local branch of `fetchSourceModels`/`LiveModel` to query `/api/v0/models` and map the native fields; keep cloud/gateway/api-key sources on `/v1/models`. <!-- D-001 --> <!-- D-005 -->
  3. RED: Add tests for degradation - `/api/v0` unreachable, non-OK, or missing fields - asserting an id-only entry plus `stale`, never a dropped model. <!-- D-006 -->
  4. GREEN: Implement the id-only fallback and stale marking on the local path.
  5. REFACTOR: Factor a shared native-record parser used by both `fetchSourceModels` and `LmStudioClient.fetchModelInfo()` so `/api/v0` is parsed in one place.

#### M2: Extend `CatalogEntry` with Quantization + Arch

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Add contract tests that `CatalogEntry` carries optional `quantization` and `arch`, that they decode/round-trip, and that send-time model metadata preserves them.
  2. GREEN: Add the optional fields to `CatalogEntry` in `packages/session/src/model-source.ts` and thread them through `entryFor`. <!-- D-002 -->
  3. RED: Add tests proving cloud entries leave `quantization`/`arch` absent (no regression to the cloud path).
  4. GREEN: Populate the new fields only for local entries.
  5. REFACTOR: Keep the read-model change additive and backward-compatible for existing decoders.

### Gate 1-2

- [ ] The local catalog fetch reads `/api/v0/models` and surfaces quantization/type/arch/context/capabilities.
- [ ] `/api/v0` failure degrades to id-only + stale, never an empty or dropped local model.
- [ ] `CatalogEntry` carries optional quantization/arch; cloud entries are unaffected.

### Phase 2: Live Capability Derivation

**Goal:** Local capability/vision/context come from the native record, not hardcoded values or the cloud-only registry.

**Gate from previous:** Native fetch + read model are in place.

#### M3: Derive Capabilities, Vision, and Context for Local

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add tests asserting a local VLM (`type: "vlm"`) gets a `vision` capability; a model whose `capabilities` lacks `tool_use` does NOT get `tools`; tools/reasoning reflect the native record.
  2. GREEN: In `entryFor`, derive `capabilities` and `vision` for local entries from the native `capabilities`/`type` instead of the hardcoded `["tools"]` + cloud-only `input` lookup. <!-- D-003 -->
  3. RED: Add a test that a local entry's `contextLength` comes from native `max_context_length`, still overridable by `models.json` via `resolveContextWindow`.
  4. GREEN: Source local `contextLength` from the native record while preserving the override precedence.
  5. REFACTOR: Separate the local vs cloud capability-derivation paths cleanly so neither hardcodes the other's assumptions.

### Gate 2-3

- [ ] Local capability chips reflect the runtime's real `capabilities`/`type`.
- [ ] Local VLMs show Vision; non-tool local models do not show Tools.
- [ ] Local context length comes from the native record, override precedence intact.

### Phase 3: Chooser Display and Verification

**Goal:** The chooser distinguishes same-id quants and reflects live capabilities, proven end to end.

**Gate from previous:** Entries carry quant + live capabilities.

#### M4: Disambiguating Display

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add Storybook/web tests where two same-id local models render distinctly with quantization (and context), e.g. `qwen3.6-27b-mlx · 8bit · 256k` vs `· 4bit · 64k`. <!-- D-004 -->
  2. GREEN: Render quantization + context alongside the id in `model-chooser.tsx`, using existing label/Badge patterns.
  3. RED: Add tests proving the existing capability filters (tools/vision/reasoning) now match the live local capabilities.
  4. GREEN: Wire the capability/Vision chips to the live `capabilities`.
  5. REFACTOR: Reuse existing chooser presentation; introduce no new card layout.

#### M5: End-to-End and Degradation Verification

- **Dependencies:** M4
- **Effort:** S
- **Tasks:**
  1. RED: Add an integration/e2e test where a fake LM Studio `/api/v0` makes the catalog show quant + live caps, and a `/api/v0`-down run falls back to id-only with the source marked stale.
  2. GREEN: Make both scenarios pass through the real catalog load path.
  3. REFACTOR: Provide a shared fixture for the native model record reused by unit, web, and e2e tests.

### Done Gate

- [ ] Unit, web, and integration/e2e tests pass for the local catalog metadata path.
- [ ] The two `qwen3.6-27b-mlx` quants are visually distinguishable in the chooser.
- [ ] Local capability/Vision/context reflect the runtime; cloud sources are unchanged.
- [ ] `/api/v0` failure degrades gracefully (id-only + stale).

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---|---|---|---|
| LM Studio `/api/v0` shape drifts across versions | medium | medium | Parse defensively with a single shared parser; missing fields degrade to id-only rather than throwing. | agent-host |
| Two readers of `/api/v0` (catalog + client) drift apart | medium | medium | Factor one native-record parser shared by `fetchSourceModels` and `LmStudioClient`. | agent-host |
| New `CatalogEntry` fields break existing decoders | medium | low | Make fields optional/additive; assert round-trip + cloud-absence in contract tests. | session |
| A non-LM-Studio local runtime lacks `/api/v0` | low | medium | Degradation path returns id-only + stale so the catalog still lists models. | agent-host |

## 5. Escape Hatches

1. **If `/api/v0` proves unreliable for listing:** keep listing from `/v1/models` and enrich each id with a per-model `/api/v0/models/:id` lookup (the endpoint `fetchModelInfo` already uses), trading N requests for resilience.
2. **If the chooser display gets noisy:** show quantization only when two entries share a base id (disambiguation-on-collision), keeping single-quant rows clean.

## 6. Validation Commands

```bash
pnpm --filter @trevor/agent-host test -- --run
pnpm --filter @trevor/session test -- --run
pnpm test -- --project web
pnpm test -- --project e2e
```

## 7. Decisions

Canonical decisions are in the plan database (`.plans/09.3-local-catalog-metadata/plan.db`). Query with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "09.3-local-catalog-metadata"
```
