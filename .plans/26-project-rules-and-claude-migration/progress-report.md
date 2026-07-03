# Project Rules And Claude Migration - Progress Report

## Summary

> Current focus: M7: Doctor, UI, And CLI Surfacing
- Current cutoff blockers: 18 unchecked
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0

## Current Cutoff

### M1: Baseline And Source Model

- [x] RED: Add unit tests documenting the current D-080 eager/lazy `AGENTS.md` behavior as the baseline this feature must preserve.
- [x] GREEN: Add a context-source abstraction that can represent `AGENTS.md`, rule files, and migration diagnostics without changing rendered output.
- [x] RED: Add tests for rule metadata parsing with id, title, description, inclusion mode, globs, priority, enabled state, and folder provenance.
- [x] GREEN: Implement `.trevor/rules` rule-file and folder-metadata parsing.
- [x] RED: Add tests for malformed metadata, duplicate ids, disabled rules, and unknown metadata fields.
- [x] GREEN: Return typed diagnostics for malformed or ignored rule metadata without failing a turn.
- [x] REFACTOR: Keep parsing pure and independent from `buildSystemPrompt`.

### M2: Rules Loading And Rendering

- [x] RED: Add tests for always-included rules rendering after user-global/project `AGENTS.md`.
- [x] GREEN: Render always-included rules through the existing context registry and byte budget.
- [x] RED: Add tests for path-scoped rules loading only when cwd/file access matches their folder or globs.
- [x] GREEN: Wire path-scoped rules into the lazy context path already used by below-cwd `AGENTS.md`.
- [x] RED: Add tests proving imported rule files retain source and included-folder metadata.
- [x] GREEN: Preserve source path, folder, inclusion reason, metadata, and byte accounting in rendered context reports.
- [x] REFACTOR: Reuse D-080 import expansion and truncation logic instead of adding a second importer.

### Gate 1 to 2

- [x] Existing D-080 `AGENTS.md` tests still pass unchanged.
- [x] `.trevor/rules` parsing and rendering are covered by unit tests.
- [x] Context reports distinguish `AGENTS.md` and `.trevor/rules` sources.

### M3: `/init` Discovery And Drafting

- [x] RED: Add command tests proving `/init` scans repo docs, package metadata, scripts, test config, existing AGENTS.md, nested AGENTS.md, `.trevor/rules`, and CLAUDE.md migration inventory.
- [x] GREEN: Implement `/init` discovery as a bounded read-only scan with ignored directories and typed evidence records.
- [x] RED: Add tests proving generated AGENTS.md content includes only evidence-backed facts or clearly labeled suggested additions.
- [x] GREEN: Generate a compact AGENTS.md draft with sections for project overview, important files, build/test commands, coding standards, storage/state roots, safety constraints, and review expectations.
- [x] RED: Add tests proving `/init` points to existing docs and source files instead of copying long content into AGENTS.md.
- [x] GREEN: Prefer links, file paths, and exact commands over broad explanatory prose.
- [x] RED: Add tests for create, merge/refresh, no-op, and nested scoped AGENTS.md proposal modes.
- [x] GREEN: Return a required-response proposal with bounded preview and structured diff before any write.
- [x] REFACTOR: Keep the generator deterministic so repeated `/init` runs produce stable proposals from the same evidence.

### Gate 2 to 3

- [x] `/init` discovery is read-only until the user accepts a proposal.
- [x] Generated AGENTS.md content is evidence-backed and compact.
- [x] Existing AGENTS.md and CLAUDE.md migration flows compose without competing writes.

### M4: CLAUDE.md Discovery

- [x] RED: Add tests for bounded workspace discovery of root and nested `CLAUDE.md` files.
- [x] GREEN: Implement discovery with ignores for `.git`, `node_modules`, generated build output, dependency caches, and Trevor-managed generated roots.
- [x] RED: Add tests mapping each `CLAUDE.md` to its sibling `AGENTS.md` path and current sibling state.
- [x] GREEN: Build a migration inventory with path, sibling path, sibling-exists state, pointer state, and bounded preview.
- [x] RED: Add tests proving converted pointer files are recognized and not re-proposed.
- [x] GREEN: Add pointer detection and idempotent discovery results.

### M5: Required-Response Proposal

- [x] RED: Add host flow tests proving a detected migration blocks on required user response before writes occur.
- [x] GREEN: Add a required-response proposal event or reuse the existing ask-user/request pattern with structured options.
- [x] RED: Add tests for create, merge, leave unchanged, ignore once, and ignore permanently responses.
- [x] GREEN: Implement response handling with durable decision state for ignored files.
- [x] RED: Add tests for grouped nested proposals where different files can receive different actions.
- [x] GREEN: Support multi-item proposals while keeping each file's action explicit.
- [x] REFACTOR: Keep proposal generation separate from filesystem mutation.

### M6: Conversion, Merge, And Pointer Rewrite

- [x] RED: Add filesystem tests for creating a sibling `AGENTS.md` from `CLAUDE.md` content with provenance.
- [x] GREEN: Implement create conversion and atomic write behavior.
- [x] RED: Add tests for merging into an existing sibling `AGENTS.md` with clear migrated-section markers.
- [x] GREEN: Implement merge conversion without losing existing `AGENTS.md` content.
- [x] RED: Add tests proving successful create/merge rewrites `CLAUDE.md` into an idempotent pointer to `AGENTS.md`.
- [x] GREEN: Implement pointer rewrite and rollback-safe error handling.
- [x] REFACTOR: Keep file operations explicit, auditable, and never triggered without the recorded user response.

### Gate 3 to 4

- [x] Root and nested `CLAUDE.md` detection is covered.
- [x] Conversion and merge never run without required user response.
- [x] Pointer rewrite is idempotent and does not re-trigger migration prompts.

### M7: Doctor, UI, And CLI Surfacing

- [ ] RED: Add `/doctor` tests for `AGENTS.md`, `.trevor/rules`, detected `CLAUDE.md`, converted pointers, ignored files, bytes used, and bytes dropped.
- [ ] GREEN: Extend context diagnostics and `/doctor` output.
- [ ] RED: Add web or protocol tests for rendering required-response migration proposals.
- [ ] GREEN: Render migration proposals with paths, sibling state, bounded preview, and explicit action controls.
- [ ] RED: Add tests proving debug output does not dump full instruction/rule bodies by default.
- [ ] GREEN: Redact or summarize bodies in ordinary diagnostics while leaving explicit inspection possible.

### M8: E2E And Regression Coverage

- [ ] RED: Add hermetic e2e coverage for `/init` in a repo with root `AGENTS.md`, nested `AGENTS.md`, and `.trevor/rules`.
- [ ] GREEN: Prove prompt context ordering and lazy loading remain stable.
- [ ] RED: Add hermetic e2e coverage for root and nested `CLAUDE.md` migration proposals.
- [ ] GREEN: Drive create, merge, skip, and pointer-idempotence paths end to end.
- [ ] RED: Add regression tests proving existing D-080 lazy `AGENTS.md` behavior is unchanged when no rules or `CLAUDE.md` files exist.
- [ ] GREEN: Stabilize the no-op path so projects without the new files get byte-for-byte existing prompt behavior where possible.
- [ ] REFACTOR: Keep test fixtures small and focused on source ordering, required response, and file mutation safety.

### Gate 3 to Done

- [ ] `pnpm test --project unit` passes for context parsing and migration logic.
- [ ] `pnpm test --project integration` passes for host proposal and filesystem flows.
- [ ] `pnpm test --project web` passes if migration proposal UI changes.
- [ ] `pnpm test --project e2e` passes for hermetic context and migration workflows.
- [ ] D-080 shipped behavior remains unchanged for projects without `.trevor/rules` or `CLAUDE.md`.
