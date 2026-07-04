# Local Observation Corpus - Progress Report

> Current focus: Complete

## Summary

- Current cutoff blockers: 0
- Deferred follow-up: 0
- Superseded checklist debt: 0

## Hard Dependencies

- [x] `03-filesystem-root-taxonomy` complete before expanding observation persistence
- [x] `.plans/trevor-v2` D-076-D-079 provider-outage recovery exists as the first producer
- [x] `apps/agent-host/src/paths.ts` exposes `TREVOR_STATE_HOME`

## M1: Path Ownership and Migration

- [x] RED: Add tests proving observation paths resolve under `TREVOR_STATE_HOME/observations`, including `XDG_STATE_HOME` overrides
- [x] GREEN: Replace the provider observation path owner with the shared `TREVOR_STATE_HOME` constant
- [x] RED: Add migration tests for an existing `<TREVOR_HOME>/provider-observations.json` file
- [x] GREEN: Import or convert the old file into the new state-root corpus, preserving fingerprints/counts
- [x] REFACTOR: Remove duplicated home resolution from the provider observation store

## M2: Common Observation Envelope

- [x] RED: Add schema tests for a versioned observation envelope shared by provider and future producers
- [x] GREEN: Implement the common envelope and provider-failure adapter
- [x] RED: Add tests for redaction version, kind-specific payload validation, and corrupt-record tolerance
- [x] GREEN: Decode valid records defensively and ignore invalid lines with a visible diagnostic summary
- [x] REFACTOR: Keep provider-specific fields under a `shape`/`source` payload instead of top-level drift

## M3: Append, Dedupe, and Retention Mechanics

- [x] RED: Add tests for append-only writes plus stable fingerprint dedupe into an index
- [x] GREEN: Implement append and index update so repeated shapes increment count/lastSeen
- [x] RED: Add tests for write failure, corrupt index, concurrent writes, and large corpus behavior
- [x] GREEN: Make writes best-effort and index repairable from JSONL when needed
- [x] REFACTOR: Isolate filesystem persistence from observation normalization and fingerprinting

## M4: Doctor and Debug Summary

- [x] RED: Add `/doctor` snapshot tests for corpus path, writeability, counts, unknown count, and top fingerprints
- [x] GREEN: Update live doctor assembly to read the new observation summary
- [x] RED: Add tests proving `/doctor` never displays raw messages, auth values, prompts, or payload bodies
- [x] GREEN: Surface only counts, fingerprints, producer kinds, and sanitized statuses
- [x] REFACTOR: Keep provider-failure log summaries distinct from observation-corpus summaries

## M5: Inspect, Export, and Delete

- [x] RED: Add CLI or command tests for listing observation summaries and exporting redacted records
- [x] GREEN: Implement explicit inspect/export command paths over the corpus
- [x] RED: Add tests for deleting the corpus or deleting by kind/fingerprint
- [x] GREEN: Implement removal with confirmation where interactive surfaces require it
- [x] REFACTOR: Document privacy boundaries and the exact fields that may be exported

## M6: Provider Failure Producer Hardening

- [x] RED: Add tests for unknown, low-confidence, retry-exhausted, and non-retryable provider observations
- [x] GREEN: Normalize provider failure producer calls into the common observation API
- [x] RED: Add tests proving known/actionable auth, quota, and context-overflow failures do not spam the corpus
- [x] GREEN: Record only useful classifier-gap evidence with stable fingerprints
- [x] REFACTOR: Share fingerprint logic with provider-failure debug logging where correlation is useful

## M7: Later Producer Hooks

- [x] RED: Add disabled-by-default tests or fixtures for tool-pattern, loop-pattern, and harness-guidance observation kinds
- [x] GREEN: Add schema support for those kinds without wiring automatic producers yet
- [x] RED: Add tests proving raw tool outputs, full prompts, and transcript text are rejected or redacted
- [x] GREEN: Provide narrow producer APIs that accept only shape summaries
- [x] REFACTOR: Keep every new producer opt-in until a concrete plan authorizes it

## M8: Classifier Consumption Gate

- [x] RED: Add tests proving observation records are never injected into model prompts or history projection
- [x] GREEN: Keep corpus reads limited to doctor/debug/export surfaces in this plan
- [x] RED: Add tests proving classifier rules are not mutated at runtime from observation data
- [x] GREEN: Document future classifier-improvement workflow as offline/manual unless a later plan changes it
- [x] REFACTOR: Add clear code comments around the non-consumption boundary

## M9: End-to-End Verification

- [x] RED: Add integration test that triggers an unknown provider failure and verifies a redacted state-root observation
- [x] GREEN: Make the full path pass through provider failure handling, corpus write, and doctor summary
- [x] RED: Add migration smoke test from old TREVOR_HOME provider-observations file to new XDG state file
- [x] GREEN: Verify old and new installations converge on the new corpus path
- [x] REFACTOR: Update docs and AGENTS guidance references that still say provider observations live under `TREVOR_HOME`
