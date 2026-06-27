# Capability Manifest and Trevor Expert - Implementation Plan

## 0. Hard Dependencies

- [ ] `18-nested-command-menu` - command families, nested menu choices, and `/style` metadata must have a structured surface the manifest can describe.
- [ ] `.plans/trevor-v2` D-075 discovery registry current cutoff - skill registry, compact roster, `skills_list`, and `skill_view` must expose deterministic metadata for manifest and `trevor-expert` consumption.

## 1. Architecture

Trevor needs a host-generated capability manifest and a built-in `trevor-expert` explainer in one plan. The manifest answers "what can this Trevor host do?" for humans, clients, subagents, exports, and built-in explanation surfaces. It is derived from live registries and current host state, not handwritten documentation.

`trevor-expert` is the first privileged consumer. It answers questions about Trevor from deterministic host-generated exports: compact/full manifests, Doctor summaries, discovery registry excerpts, version/protocol information, runtime status, and source provenance. It must not scrape arbitrary files, grant permissions, mutate state, start work, bypass slash/tool authority, or become a giant prompt dump.

`trevor-export` is the host-owned export command/API for the same data. General interpolation inside skills or command files is separate and risky: it is configurable, defaults disabled, and is enabled only through an explicit environment variable or equivalent trust gate. The built-in `trevor-expert` does not have to depend on that global interpolation setting; as a trusted built-in, it may access bounded read-only host exports through a direct host API/tool path, or through the same interpolation mechanism only when that mechanism is explicitly enabled.

### Key Constraints

| Constraint | Impact |
|---|---|
| Registry-derived | The manifest is generated from source-of-truth registries and host state, not manually maintained prose. |
| Full and compact forms | Full export is for humans/clients/debug; compact export is scoped and budgeted for prompts/subagents. |
| Not a permission system | The manifest describes capabilities but never grants access, changes allow-lists, or bypasses tool/command authority. |
| Dynamic inventories summarized | MCP servers, model catalogs, docs corpora, and provider/model lists expose counts/status/search affordances, not full dumps. |
| `trevor-expert` is built in | It can use deterministic host export APIs without requiring global risky interpolation. |
| General interpolation is separate | Command/skill interpolation remains its own configurable feature, disabled by default unless enabled by env/trust gate. |
| `trevor-export` is bounded | Every export variant has output caps, redaction, scope metadata, and stable machine-readable JSON. |

### Boundaries

- **Manifest builder:** composes registered sections from tools, commands, command families, nested menus, styles, skills, agents, MCP, LSP, hooks, docs/web status, Doctor areas, provider/source/catalog summaries, runtime surfaces, protocol/version, and workspace facts.
- **Section providers:** each subsystem owns a small manifest section adapter. Missing/unavailable sections are explicit, not silently omitted.
- **Export command/API:** `trevor-export` returns human-readable summary and JSON variants for compact, full, section-scoped, and `trevor-expert`-scoped output.
- **`trevor-expert`:** built-in skill/agent surface that loads bounded deterministic exports on demand and explains Trevor behavior from those exports.
- **General interpolation:** separate configuration plane for `!command` / command interpolation inside skill/command files. This plan may define the safe consumer boundary, but it does not make interpolation generally enabled.

### Observability

- Manifest exports include version, generated time, host build/version when known, workspace/cwd when relevant, registry provenance, omitted/truncated sections, and section freshness.
- Export logs record variant, scope, section counts, truncation, and redaction status, never raw secrets or prompt text.
- `/doctor` can report manifest generation health and `trevor-expert` export access failures.
- Tests prove redaction, caps, and deterministic output shape across repeated exports.

## 2. Phases

### Phase 1: Manifest Contract and Section Registry

**Goal:** Trevor has a typed, versioned manifest contract and a registry of section providers.

**Gate from previous:** `18-nested-command-menu` and D-075 discovery registry current cutoff are available.

#### M1: Manifest Schema

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add protocol/contract tests for manifest version, generated time, scope, sections, provenance, truncation, and unavailable-section representation.
  2. GREEN: Define full and compact manifest schemas with stable section ids.
  3. RED: Add tests proving manifest payloads are not permission grants and do not contain executable authority.
  4. GREEN: Keep authorization/allow-list metadata descriptive only.
  5. REFACTOR: Keep manifest types separate from command/tool execution types.

#### M2: Section Provider Registry

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for registering section providers and composing deterministic section order.
  2. GREEN: Implement section-provider registry and manifest builder.
  3. RED: Add tests for missing, failed, slow, or unavailable section providers.
  4. GREEN: Represent unavailable sections explicitly with sanitized status and no thrown export failure.
  5. REFACTOR: Keep each provider small and owned by the relevant subsystem.

#### M3: Core Registry-Derived Sections

- **Dependencies:** M1, M2, `18-nested-command-menu`, D-075
- **Effort:** L
- **Tasks:**
  1. RED: Add tests for tool, command, command-family, nested-menu, style, skill, and agent summary sections.
  2. GREEN: Build sections from existing registries and D-075 discovery outputs.
  3. RED: Add tests proving hidden/debug-only capabilities are filtered or marked by scope.
  4. GREEN: Implement scope-aware filtering for human, client, compact, subagent, and expert scopes.
  5. REFACTOR: Remove duplicated hardcoded lists from manifest sections.

### Phase 2: Dynamic Runtime Sections

**Goal:** Large or changing surfaces are summarized without dumping inventories.

**Gate from previous:** Phase 1 schema and section registry are stable.

#### M4: Runtime and Integration Sections

- **Dependencies:** M1-M3
- **Effort:** L
- **Tasks:**
  1. RED: Add tests for MCP, LSP, hooks, docs/web, Doctor areas, provider/source/catalog, runtime, protocol, and workspace summaries.
  2. GREEN: Add bounded section providers with counts, status, search/read affordances, and freshness metadata.
  3. RED: Add tests for huge catalogs and corpora proving entries are summarized, not fully inlined.
  4. GREEN: Cap dynamic sections and expose explicit query/read affordances for detail.
  5. REFACTOR: Share freshness/truncation/provenance helpers across dynamic sections.

#### M5: Compact Manifest for Prompts and Subagents

- **Dependencies:** M1-M4
- **Effort:** M
- **Tasks:**
  1. RED: Add token-budget tests for compact manifest variants.
  2. GREEN: Build scoped compact manifest generation with summaries and discovery pointers.
  3. RED: Add tests proving normal turns never receive the full manifest.
  4. GREEN: Include compact manifest only where scoped and useful, such as selected subagent/expert contexts.
  5. REFACTOR: Keep compact prompt text generated from structured manifest data, not separate prose.

### Phase 3: `trevor-export`

**Goal:** Host-owned export command/API exposes manifest data in bounded human and JSON forms.

**Gate from previous:** Phase 1 and Phase 2 manifest generation pass.

#### M6: Export Command/API Variants

- **Dependencies:** M1-M5
- **Effort:** M
- **Tasks:**
  1. RED: Add command tests for `trevor-export` full, compact, json, section, and expert-scoped variants.
  2. GREEN: Implement host-owned export command/API with stable JSON and human-readable summary output.
  3. RED: Add tests for output caps, redaction, unavailable sections, and deterministic ordering.
  4. GREEN: Apply caps/redaction/scope metadata to every export variant.
  5. REFACTOR: Keep export formatting separate from manifest construction.

#### M7: Interpolation Boundary

- **Dependencies:** M6
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving general interpolation inside skill/command files defaults disabled.
  2. GREEN: Define the env/trust gate for general command interpolation without enabling it by default.
  3. RED: Add tests proving `trevor-export` can be used as a bounded read-only interpolation target only when interpolation is enabled.
  4. GREEN: Document and enforce command allow-listing, output caps, timeout, cwd policy, and redaction for interpolated export calls.
  5. REFACTOR: Keep the built-in `trevor-expert` direct export path independent from the global interpolation gate.

### Phase 4: Built-In `trevor-expert`

**Goal:** Trevor can explain itself from deterministic host exports without stale prose or prompt bloat.

**Gate from previous:** `trevor-export` and compact/expert-scoped manifests are available.

#### M8: Expert Built-In Surface

- **Dependencies:** M5, M6
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for built-in `trevor-expert` discovery metadata and trigger visibility.
  2. GREEN: Register `trevor-expert` as a built-in expert surface that is discoverable but not dumped into every prompt.
  3. RED: Add tests proving it loads only bounded deterministic export slices needed for the question.
  4. GREEN: Implement direct host export access for built-in expert queries, with interpolation optional only when enabled.
  5. REFACTOR: Keep `trevor-expert` query orchestration separate from manifest generation.

#### M9: Expert Safety and Answer Quality

- **Dependencies:** M8
- **Effort:** M
- **Tasks:**
  1. RED: Add tests/evals proving `trevor-expert` does not mutate state, grant permissions, start work, or bypass command/tool authority.
  2. GREEN: Clamp `trevor-expert` to read-only deterministic host exports and bounded explanation output.
  3. RED: Add evals for questions about tools, commands, skills, providers, Doctor, project rules, protocol/version, and missing/unavailable sections.
  4. GREEN: Answer from exports with provenance and explicit unknown/unavailable states.
  5. REFACTOR: Keep default turns aware only that `trevor-expert` exists, with detail loaded on demand.

### Phase 5: Verification

**Goal:** Manifest, export, interpolation boundary, and `trevor-expert` are stable enough to implement.

**Gate from previous:** M1-M9 pass.

#### M10: End-to-End Verification

- **Dependencies:** M1-M9
- **Effort:** M
- **Tasks:**
  1. RED: Add integration tests from registries to manifest to `trevor-export` to `trevor-expert` answer.
  2. GREEN: Verify full and compact exports, expert-scoped slices, unavailable sections, and dynamic-section truncation.
  3. RED: Add redaction tests for secrets, auth headers, prompt text, provider payloads, raw tool output, and local sensitive paths.
  4. GREEN: Verify redacted output and stable provenance across human, JSON, compact, and expert variants.
  5. REFACTOR: Tighten docs and command names so future clients can consume the manifest without scraping prompt text.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---:|---:|---|---|
| Manifest becomes stale documentation | high | medium | Generate from registries and add drift tests proving source changes alter the manifest. | Host |
| Compact manifest bloats prompts | high | medium | Token-budget tests and scoped inclusion only. | Host |
| `trevor-expert` bypasses authority | high | low | Clamp to read-only deterministic exports and test no mutation/start-work paths. | Host |
| General interpolation enables risky command execution | high | medium | Keep it separate, disabled by default, env/trust gated, bounded, and allow-listed. | Host |
| Dynamic catalogs dump too much data | medium | medium | Summarize counts/status and expose query affordances instead of full entries. | Host |

## 4. Escape Hatches

1. **If the manifest is too large:** ship section-scoped and compact exports first, defer full human export formatting.
2. **If interpolation policy is not ready:** ship `trevor-expert` through direct built-in host export access and leave general interpolation as a later separate plan.
3. **If dynamic sections are unstable:** mark sections unavailable or stale with provenance and keep export generation successful.

## 5. Progress Report Accounting

The progress report is `.plans/19-capability-manifest-and-trevor-expert/progress-report.md`. It tracks only the current cutoff for capability manifest, `trevor-export`, interpolation boundary decisions for exports, and built-in `trevor-expert`. General command/skill interpolation beyond bounded `trevor-export` access remains a separate future feature.

Before implementation resumes, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "19-capability-manifest-and-trevor-expert"
```

## 6. Validation Commands

```bash
pnpm test
pnpm --filter @trevor/agent-host test
pnpm --filter @trevor/web test
pnpm typecheck
```

## 7. Decisions

Canonical decisions are in `.plans/19-capability-manifest-and-trevor-expert/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "19-capability-manifest-and-trevor-expert"
```
