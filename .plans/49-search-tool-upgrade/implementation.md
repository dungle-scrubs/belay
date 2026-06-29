# Search Tool Upgrade - Implementation Plan

## 0. Hard Dependencies

- [x] Existing `grep` tool and tool registry exist in `apps/agent-host`.
- [x] D-050 concurrent read-only tool execution is the purity/concurrency model this plan must preserve.
- [x] Workspace confinement and output caps already exist as tool safety requirements.

## Scope

Extracted from D-062 in the umbrella. This plan owns: making provider-facing `grep` ripgrep-backed, adding a read-only `ast_grep` structural-search tool, and introducing a shared bounded child-process helper for read-only external search binaries. It does not rename the model-facing `grep` tool.

## Phases

### M1 - Shared Search Process Helper

- [ ] RED: Cover argv-only execution, cwd confinement, timeout, max output, interruption cleanup, and typed nonzero/no-match handling.
- [ ] GREEN: Implement the bounded helper without shell expansion.
- [ ] REFACTOR: Keep it specific to read-only external search binaries; `bash` remains separate.

### M2 - Ripgrep-Backed `grep`

- [ ] RED: Cover no-match, gitignore behavior, literal/regex, invalid regex, caps, confinement, truncation, and read-only registry.
- [ ] GREEN: Replace custom scanning with ripgrep while preserving provider-visible name and schema.
- [ ] REFACTOR: Keep prompt/tool inventory behavior stable.

### M3 - `ast_grep` Tool

- [ ] RED: Cover TS/TSX structural matches, lang inference/explicit lang, globs/paths, no-match, invalid pattern/lang, caps, confinement, and read-only registry.
- [ ] GREEN: Add `ast_grep` read-only search using JSON output and compact capped match rows.
- [ ] REFACTOR: Add prompt guidance for text search vs structural search.

## Decisions

Canonical decisions are in `.plans/49-search-tool-upgrade/plan.db`.
