# Search Tool Upgrade - Progress Report

## Summary

- **Current cutoff blockers:** 0
- **Completed current work:** 9
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** Done - all milestones (M1-M3) landed

## Completed Current State / Hard Dependencies

- [x] Existing `grep` tool and registry are present.
- [x] D-050 read-only tool purity/concurrency model exists.
- [x] Workspace confinement and output caps are established tool requirements.

## Current Cutoff Blockers

- [x] RED: Cover argv-only execution, cwd confinement, timeout, max output, interruption cleanup, and typed nonzero/no-match handling. (`search-process.ts` runner; exercised by `grep.test.ts` / `ast-grep.test.ts`)
- [x] GREEN: Implement the bounded helper without shell expansion. (`search-process.ts` runs an argv array via `execFile`, never a shell string)
- [x] REFACTOR: Keep it specific to read-only external search binaries. (module doc scopes it to the binary-backed search tools; shell floor stays in `run-shell.ts`)
- [x] RED: Cover ripgrep no-match, gitignore behavior, literal/regex, invalid regex, caps, confinement, truncation, and read-only registry. (`grep.test.ts`)
- [x] GREEN: Replace custom scanning with ripgrep while preserving provider-visible name and schema. (`grep.ts` uses `@vscode/ripgrep` `rgPath`; tool name/schema unchanged)
- [x] REFACTOR: Keep prompt/tool inventory behavior stable. (`grepTool` stays registered in `tools/index.ts`)
- [x] RED: Cover `ast_grep` structural-search cases, invalid input, caps, confinement, and read-only registry. (`ast-grep.test.ts`)
- [x] GREEN: Add `ast_grep` read-only search using compact capped match rows. (`ast-grep.ts` via `astGrepPath`; registered conditionally in `tools/index.ts`)
- [x] REFACTOR: Add prompt guidance for text search vs structural search. (`system-prompt.ts` references the search tools)

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.
