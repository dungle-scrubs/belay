# Project Rules And Claude Migration - Implementation Plan

## 0. Hard Dependencies

- [x] `01-ask-user-tool` - `CLAUDE.md` conversion, merge, and pointer rewrites require an explicit required-response user decision. (Satisfied: plan 01 merged to main and its plan dir deleted; `ask_user` tool + `providerQuestionRuntime` required-response path shipped and reused by M5's migration proposal.)
- [x] **Reorg (plan 22.1):** Plan 22.1 renames src/context/ to src/project-context/ (including agents-md.ts, registry.ts, rules.ts, init-agents.ts, claude-migration.ts that this plan edits) and homes slash commands under commands/. Target the post-22.1 paths and register /init under commands/. <!-- D-016 --> (Satisfied: plan 22.1 merged and deleted; code lives under `apps/agent-host/src/project-context/` and `/init` is registered under `apps/agent-host/src/commands/commands.ts`.)

## Architecture

<!-- D-001 --> This plan extends the shipped D-080 context system instead of rebuilding it. Trevor already loads `AGENTS.md` eagerly from user-global/root-to-cwd and lazily below cwd on file access. The new work adds Trevor-owned rule files under `<cwd>/.trevor/rules`, detects legacy or parallel `CLAUDE.md` files, and offers required-response conversion or merge operations into sibling `AGENTS.md` files.

### Current Baseline

The existing code lives in `apps/agent-host/src/context/agents-md.ts`, `apps/agent-host/src/context/registry.ts`, `apps/agent-host/src/providers/system-prompt.ts`, file-touch tools, and `/doctor` state. It already supports `@path` imports, byte budgets, eager/lazy scope ordering, lazy deduplication, compaction survival, and context diagnostics.

### Reference

- OpenAI, ["Harness engineering for agentic coding"](https://openai.com/index/harness-engineering/): use `AGENTS.md` as an agent-facing operating guide that captures repo-specific workflow, commands, review expectations, and pointers to deeper sources of truth.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| <!-- D-002 --> Do not duplicate D-080 | Reuse `ContextRegistry`, context rendering, file-access hooks, import expansion, byte accounting, and `/doctor` reporting. |
| <!-- D-003 --> Rules are Trevor-owned | `<cwd>/.trevor/rules` is the project-local rules home for Trevor-specific modular instructions; it is not a second `AGENTS.md` chain. |
| <!-- D-004 --> Claude compatibility is migration-only | Trevor detects `CLAUDE.md` and offers conversion/merge, but does not keep `CLAUDE.md` as a first-class loaded instruction source. |
| <!-- D-005 --> Required user response | Any conversion, merge, overwrite, or pointer rewrite must block on an explicit user response. No silent file edits. |
| <!-- D-006 --> Nested files are included | Detection and migration cover root and nested `CLAUDE.md` files inside the workspace, with the corresponding sibling `AGENTS.md` in the same directory. |
| <!-- D-013 --> `/init` generates AGENTS.md drafts | `/init` inspects the repo and proposes a concise AGENTS.md as a navigational operating guide, not a synthetic replacement for existing docs. |

### Rules Directory

<!-- D-007 --> `<cwd>/.trevor/rules` contains modular Markdown rules. Each rule file can include frontmatter metadata for id, title, description, inclusion mode, path globs, priority, and enabled state. Folder-level metadata is supported through a metadata file in the rule folder, and every rendered rule carries provenance: source path, folder, inclusion reason, metadata, and byte contribution.

<!-- D-008 --> Rule inclusion mirrors Claude-style behavior in spirit: always-included rules load with the project context, scoped rules load only when their folder/glob applies or when a touched file enters their scope, and imported rule files retain provenance. Rules are rendered after user-global/project `AGENTS.md` but before below-cwd lazy `AGENTS.md` when they apply globally; path-scoped rules render with the lazy context for the file scope that caused them to load.

### CLAUDE.md Detection And Migration

<!-- D-009 --> The host scans for `CLAUDE.md` files within the workspace using bounded filesystem discovery that excludes `.git`, `node_modules`, build output, dependency caches, and Trevor-managed generated roots. The scan includes nested files and records the corresponding sibling `AGENTS.md` path for each.

<!-- D-010 --> When any `CLAUDE.md` is detected, Trevor presents a required-response proposal before normal turn execution continues. Each item offers create `AGENTS.md`, merge into existing `AGENTS.md`, leave unchanged, or ignore this file. The proposal shows paths, whether a sibling `AGENTS.md` exists, a bounded preview, and whether the operation would rewrite the `CLAUDE.md` file into a pointer.

<!-- D-011 --> Conversion preserves content and provenance. If no sibling `AGENTS.md` exists, Trevor creates one from the `CLAUDE.md` body with a short provenance header. If one exists, Trevor appends or inserts a clearly marked migrated section unless the user chooses a manual merge path. After a successful create or merge, the original `CLAUDE.md` is replaced with a small pointer to the sibling `AGENTS.md`.

<!-- D-011 --> Pointer files are idempotent. Re-running detection should recognize an already-converted `CLAUDE.md` pointer, avoid re-proposing the same migration, and report the pointer relationship in diagnostics.

### Observability

<!-- D-012 --> Context diagnostics distinguish `AGENTS.md`, `.trevor/rules`, detected `CLAUDE.md`, converted pointers, skipped migrations, bytes used, bytes dropped, inclusion reasons, and required-response state. Debug output must avoid dumping full rule or instruction bodies unless the user explicitly asks to inspect them.

### `/init` AGENTS.md Generation

<!-- D-014 --> `/init` is the explicit command for bootstrapping or refreshing project instructions. It should inspect the repository, summarize what is stable and actionable, and generate a proposed `AGENTS.md` that behaves like the article's harness-oriented examples: a compact operating guide that points agents to the right source files, docs, tests, commands, and review expectations. It must prefer links and specific commands over broad prose, avoid copying large docs into the file, and clearly separate verified repo facts from suggested additions.

<!-- D-015 --> `/init` writes only after review. If no `AGENTS.md` exists, it proposes a create action. If one exists, it proposes a merge/refresh with a structured diff. If `CLAUDE.md` exists too, `/init` should compose with the CLAUDE migration flow rather than creating competing instructions. For nested directories, `/init` can propose scoped sibling `AGENTS.md` files only when the scan finds meaningful directory-specific conventions.

---

## Phases

### Phase 1: Rules Source Model

**Goal:** Trevor has a typed, testable model for `.trevor/rules` without changing prompt behavior yet.

#### M1: Baseline And Source Model

- **Dependencies:** shipped D-080 context registry
- **Effort:** M
- **Tasks:**
  1. RED: Add unit tests documenting the current D-080 eager/lazy `AGENTS.md` behavior as the baseline this feature must preserve.
  2. GREEN: Add a context-source abstraction that can represent `AGENTS.md`, rule files, and migration diagnostics without changing rendered output.
  3. RED: Add tests for rule metadata parsing with id, title, description, inclusion mode, globs, priority, enabled state, and folder provenance.
  4. GREEN: Implement `.trevor/rules` rule-file and folder-metadata parsing.
  5. RED: Add tests for malformed metadata, duplicate ids, disabled rules, and unknown metadata fields.
  6. GREEN: Return typed diagnostics for malformed or ignored rule metadata without failing a turn.
  7. REFACTOR: Keep parsing pure and independent from `buildSystemPrompt`.

#### M2: Rules Loading And Rendering

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for always-included rules rendering after user-global/project `AGENTS.md`.
  2. GREEN: Render always-included rules through the existing context registry and byte budget.
  3. RED: Add tests for path-scoped rules loading only when cwd/file access matches their folder or globs.
  4. GREEN: Wire path-scoped rules into the lazy context path already used by below-cwd `AGENTS.md`.
  5. RED: Add tests proving imported rule files retain source and included-folder metadata.
  6. GREEN: Preserve source path, folder, inclusion reason, metadata, and byte accounting in rendered context reports.
  7. REFACTOR: Reuse D-080 import expansion and truncation logic instead of adding a second importer.

### Gate 1 to 2

- [ ] Existing D-080 `AGENTS.md` tests still pass unchanged.
- [ ] `.trevor/rules` parsing and rendering are covered by unit tests.
- [ ] Context reports distinguish `AGENTS.md` and `.trevor/rules` sources.

### Phase 2: `/init` AGENTS.md Generation

**Goal:** Trevor can generate a reviewable AGENTS.md proposal from real repo evidence.

#### M3: `/init` Discovery And Drafting

- **Dependencies:** M1, M2
- **Effort:** M
- **Tasks:**
  1. RED: Add command tests proving `/init` scans repo docs, package metadata, scripts, test config, existing AGENTS.md, nested AGENTS.md, `.trevor/rules`, and CLAUDE.md migration inventory.
  2. GREEN: Implement `/init` discovery as a bounded read-only scan with ignored directories and typed evidence records.
  3. RED: Add tests proving generated AGENTS.md content includes only evidence-backed facts or clearly labeled suggested additions.
  4. GREEN: Generate a compact AGENTS.md draft with sections for project overview, important files, build/test commands, coding standards, storage/state roots, safety constraints, and review expectations.
  5. RED: Add tests proving `/init` points to existing docs and source files instead of copying long content into AGENTS.md.
  6. GREEN: Prefer links, file paths, and exact commands over broad explanatory prose.
  7. RED: Add tests for create, merge/refresh, no-op, and nested scoped AGENTS.md proposal modes.
  8. GREEN: Return a required-response proposal with bounded preview and structured diff before any write.
  9. REFACTOR: Keep the generator deterministic so repeated `/init` runs produce stable proposals from the same evidence.

### Gate 2 to 3

- [ ] `/init` discovery is read-only until the user accepts a proposal.
- [ ] Generated AGENTS.md content is evidence-backed and compact.
- [ ] Existing AGENTS.md and CLAUDE.md migration flows compose without competing writes.

### Phase 3: CLAUDE.md Migration Workflow

**Goal:** Trevor detects root and nested `CLAUDE.md` files and offers explicit conversion or merge actions.

#### M4: CLAUDE.md Discovery

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for bounded workspace discovery of root and nested `CLAUDE.md` files.
  2. GREEN: Implement discovery with ignores for `.git`, `node_modules`, generated build output, dependency caches, and Trevor-managed generated roots.
  3. RED: Add tests mapping each `CLAUDE.md` to its sibling `AGENTS.md` path and current sibling state.
  4. GREEN: Build a migration inventory with path, sibling path, sibling-exists state, pointer state, and bounded preview.
  5. RED: Add tests proving converted pointer files are recognized and not re-proposed.
  6. GREEN: Add pointer detection and idempotent discovery results.

#### M5: Required-Response Proposal

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add host flow tests proving a detected migration blocks on required user response before writes occur.
  2. GREEN: Add a required-response proposal event or reuse the existing ask-user/request pattern with structured options.
  3. RED: Add tests for create, merge, leave unchanged, ignore once, and ignore permanently responses.
  4. GREEN: Implement response handling with durable decision state for ignored files.
  5. RED: Add tests for grouped nested proposals where different files can receive different actions.
  6. GREEN: Support multi-item proposals while keeping each file's action explicit.
  7. REFACTOR: Keep proposal generation separate from filesystem mutation.

#### M6: Conversion, Merge, And Pointer Rewrite

- **Dependencies:** M5
- **Effort:** L
- **Tasks:**
  1. RED: Add filesystem tests for creating a sibling `AGENTS.md` from `CLAUDE.md` content with provenance.
  2. GREEN: Implement create conversion and atomic write behavior.
  3. RED: Add tests for merging into an existing sibling `AGENTS.md` with clear migrated-section markers.
  4. GREEN: Implement merge conversion without losing existing `AGENTS.md` content.
  5. RED: Add tests proving successful create/merge rewrites `CLAUDE.md` into an idempotent pointer to `AGENTS.md`.
  6. GREEN: Implement pointer rewrite and rollback-safe error handling.
  7. REFACTOR: Keep file operations explicit, auditable, and never triggered without the recorded user response.

### Gate 3 to 4

- [ ] Root and nested `CLAUDE.md` detection is covered.
- [ ] Conversion and merge never run without required user response.
- [ ] Pointer rewrite is idempotent and does not re-trigger migration prompts.

### Phase 4: Surfacing And Verification

**Goal:** Users can inspect loaded rules and migration state, and the whole workflow is covered end to end.

#### M7: Doctor, UI, And CLI Surfacing

- **Dependencies:** M2, M6
- **Effort:** M
- **Tasks:**
  1. RED: Add `/doctor` tests for `AGENTS.md`, `.trevor/rules`, detected `CLAUDE.md`, converted pointers, ignored files, bytes used, and bytes dropped.
  2. GREEN: Extend context diagnostics and `/doctor` output.
  3. RED: Add web or protocol tests for rendering required-response migration proposals.
  4. GREEN: Render migration proposals with paths, sibling state, bounded preview, and explicit action controls.
  5. RED: Add tests proving debug output does not dump full instruction/rule bodies by default.
  6. GREEN: Redact or summarize bodies in ordinary diagnostics while leaving explicit inspection possible.

#### M8: E2E And Regression Coverage

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: Add hermetic e2e coverage for `/init` in a repo with root `AGENTS.md`, nested `AGENTS.md`, and `.trevor/rules`.
  2. GREEN: Prove prompt context ordering and lazy loading remain stable.
  3. RED: Add hermetic e2e coverage for root and nested `CLAUDE.md` migration proposals.
  4. GREEN: Drive create, merge, skip, and pointer-idempotence paths end to end.
  5. RED: Add regression tests proving existing D-080 lazy `AGENTS.md` behavior is unchanged when no rules or `CLAUDE.md` files exist.
  6. GREEN: Stabilize the no-op path so projects without the new files get byte-for-byte existing prompt behavior where possible.
  7. REFACTOR: Keep test fixtures small and focused on source ordering, required response, and file mutation safety.

### Gate 3 to Done

- [ ] `pnpm test --project unit` passes for context parsing and migration logic.
- [ ] `pnpm test --project integration` passes for host proposal and filesystem flows.
- [ ] `pnpm test --project web` passes if migration proposal UI changes.
- [ ] `pnpm test --project e2e` passes for hermetic context and migration workflows.
- [ ] D-080 shipped behavior remains unchanged for projects without `.trevor/rules` or `CLAUDE.md`.
