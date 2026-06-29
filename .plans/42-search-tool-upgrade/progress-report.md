# Search Tool Upgrade - Progress Report

## Summary

- **Current cutoff blockers:** 9
- **Completed current work:** 3
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M1 - Shared Search Process Helper

## Completed Current State / Hard Dependencies

- [x] Existing `grep` tool and registry are present.
- [x] D-050 read-only tool purity/concurrency model exists.
- [x] Workspace confinement and output caps are established tool requirements.

## Current Cutoff Blockers

- [ ] RED: Cover argv-only execution, cwd confinement, timeout, max output, interruption cleanup, and typed nonzero/no-match handling.
- [ ] GREEN: Implement the bounded helper without shell expansion.
- [ ] REFACTOR: Keep it specific to read-only external search binaries.
- [ ] RED: Cover ripgrep no-match, gitignore behavior, literal/regex, invalid regex, caps, confinement, truncation, and read-only registry.
- [ ] GREEN: Replace custom scanning with ripgrep while preserving provider-visible name and schema.
- [ ] REFACTOR: Keep prompt/tool inventory behavior stable.
- [ ] RED: Cover `ast_grep` structural-search cases, invalid input, caps, confinement, and read-only registry.
- [ ] GREEN: Add `ast_grep` read-only search using compact capped match rows.
- [ ] REFACTOR: Add prompt guidance for text search vs structural search.

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.
