# Capability Manifest and Trevor Expert - Progress Report

> Current focus: M4: Runtime and Integration Sections

## Summary

- Current cutoff blockers: 35
- Deferred follow-up: 0
- Superseded checklist debt: 0

## Hard Dependencies

- [x] `03-nested-command-menu` complete before command-family/menu/style manifest sections are implemented
- [x] `.plans/trevor-v2` D-075 discovery registry current cutoff complete before skill/discovery manifest and `trevor-expert` slices are implemented

## M1: Manifest Schema

- [x] RED: Add protocol/contract tests for manifest version, generated time, scope, sections, provenance, truncation, and unavailable-section representation
- [x] GREEN: Define full and compact manifest schemas with stable section ids
- [x] RED: Add tests proving manifest payloads are descriptive and do not grant executable authority
- [x] GREEN: Keep authorization/allow-list metadata descriptive only
- [x] REFACTOR: Keep manifest types separate from command/tool execution types

## M2: Section Provider Registry

- [x] RED: Add tests for section provider registration and deterministic section order
- [x] GREEN: Implement section-provider registry and manifest builder
- [x] RED: Add tests for missing, failed, slow, or unavailable section providers
- [x] GREEN: Represent unavailable sections explicitly with sanitized status
- [x] REFACTOR: Keep each provider small and subsystem-owned

## M3: Core Registry-Derived Sections

- [x] RED: Add tests for tool, command, command-family, nested-menu, style, skill, and agent summary sections
- [x] GREEN: Build sections from existing registries and D-075 discovery outputs
- [x] RED: Add tests proving hidden/debug-only capabilities are filtered or marked by scope
- [x] GREEN: Implement scope-aware filtering for human, client, compact, subagent, and expert scopes
- [x] REFACTOR: Remove duplicated hardcoded lists from manifest sections

## M4: Runtime and Integration Sections

- [ ] RED: Add tests for MCP, LSP, hooks, docs/web, Doctor areas, provider/source/catalog, runtime, protocol, and workspace summaries
- [ ] GREEN: Add bounded section providers with counts, status, search/read affordances, and freshness metadata
- [ ] RED: Add tests for huge catalogs and corpora proving entries are summarized, not fully inlined
- [ ] GREEN: Cap dynamic sections and expose explicit query/read affordances
- [ ] REFACTOR: Share freshness/truncation/provenance helpers

## M5: Compact Manifest for Prompts and Subagents

- [ ] RED: Add token-budget tests for compact manifest variants
- [ ] GREEN: Build scoped compact manifest generation with summaries and discovery pointers
- [ ] RED: Add tests proving normal turns never receive the full manifest
- [ ] GREEN: Include compact manifest only where scoped and useful
- [ ] REFACTOR: Generate compact prompt text from structured manifest data

## M6: Export Command/API Variants

- [ ] RED: Add command tests for `trevor-export` full, compact, json, section, and expert-scoped variants
- [ ] GREEN: Implement host-owned export command/API with stable JSON and human-readable summaries
- [ ] RED: Add tests for output caps, redaction, unavailable sections, and deterministic ordering
- [ ] GREEN: Apply caps/redaction/scope metadata to every export variant
- [ ] REFACTOR: Keep export formatting separate from manifest construction

## M7: Interpolation Boundary

- [ ] RED: Add tests proving general interpolation inside skill/command files defaults disabled
- [ ] GREEN: Define env/trust gate for general command interpolation without enabling it by default
- [ ] RED: Add tests proving `trevor-export` can be used as a bounded read-only interpolation target only when interpolation is enabled
- [ ] GREEN: Document and enforce command allow-listing, output caps, timeout, cwd policy, and redaction for interpolated export calls
- [ ] REFACTOR: Keep built-in `trevor-expert` direct export path independent from the global interpolation gate

## M8: Expert Built-In Surface

- [ ] RED: Add tests for built-in `trevor-expert` discovery metadata and trigger visibility
- [ ] GREEN: Register `trevor-expert` as a built-in expert surface
- [ ] RED: Add tests proving it loads only bounded deterministic export slices needed for the question
- [ ] GREEN: Implement direct host export access for built-in expert queries, with interpolation optional only when enabled
- [ ] REFACTOR: Keep `trevor-expert` query orchestration separate from manifest generation

## M9: Expert Safety and Answer Quality

- [ ] RED: Add tests/evals proving `trevor-expert` does not mutate state, grant permissions, start work, or bypass authority
- [ ] GREEN: Clamp `trevor-expert` to read-only deterministic host exports and bounded explanation output
- [ ] RED: Add evals for tools, commands, skills, providers, Doctor, project rules, protocol/version, and unavailable sections
- [ ] GREEN: Answer from exports with provenance and explicit unknown/unavailable states
- [ ] REFACTOR: Keep default turns aware only that `trevor-expert` exists, with detail loaded on demand

## M10: End-to-End Verification

- [ ] RED: Add integration tests from registries to manifest to `trevor-export` to `trevor-expert` answer
- [ ] GREEN: Verify full and compact exports, expert-scoped slices, unavailable sections, and dynamic-section truncation
- [ ] RED: Add redaction tests for secrets, auth headers, prompt text, provider payloads, raw tool output, and local sensitive paths
- [ ] GREEN: Verify redacted output and stable provenance across human, JSON, compact, and expert variants
- [ ] REFACTOR: Tighten docs and command names for structured client consumption
