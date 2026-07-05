# Command Argument Substitution - Progress Report (plan 44.5)

Implementation resume state for plan 44.5. RED/GREEN/REFACTOR task tracking per milestone.

**Stage:** complete

> **Current focus:** COMPLETE - all milestones green

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks | 54 |
| Checked (done) | 54 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

Milestones: M1-M6 (6) across 3 phases. All current-cutoff at authoring time; no
deferred or superseded checklist debt. Phase 2 (M3-M4) delivers the usable slice;
Phase 3 (M5-M6) is the web preview polish.

---

## Phase 1: Substitution engine (`@trevor/session`)

### M1: Shell-style tokenizer

- [x] RED: `tokenizeArgs("a b c")` -> `["a","b","c"]` (whitespace split)
- [x] GREEN: char-scanning whitespace tokenizer
- [x] RED: double-quoted span -> one token, quotes stripped (`"two words" x`)
- [x] GREEN: double-quote grouping
- [x] RED: single-quoted span -> one token, quotes stripped
- [x] GREEN: single-quote grouping
- [x] RED: backslash escapes (`a\ b` -> `["a b"]`; `\"x` -> `['"x']`)
- [x] GREEN: backslash escape handling in the scanner
- [x] RED: unterminated quote -> consume-to-end + diagnostic flag
- [x] GREEN: unterminated-quote handling
- [x] REFACTOR: extract char-scanner, name scan states, module comment vs `interpolation-engine.ts`

### M2: Substituter + public API

- [x] RED: `expandArgs("#$0 $1", "a b")` -> `"#a b"` (0-based, D-001)
- [x] GREEN: positional `$N` -> `tokens[N]`
- [x] RED: `$ARGUMENTS` raw as typed (`'"a b"  c'` preserved); `$0` on same input = `a b` (D-002)
- [x] GREEN: raw `$ARGUMENTS` expansion (raw string carried separately from tokens)
- [x] RED: missing-arg -> empty string (`[$2]` with one arg -> `[]`, D-004)
- [x] GREEN: out-of-range positional -> `""`
- [x] RED: escaped placeholder (`\$1 $1` -> `$1 v`; `\\$1` -> backslash + expansion, D-003)
- [x] GREEN: escape-aware substitution pass
- [x] RED: `expandArgs` returns `{ text, diagnostics }` (referenced placeholders, arg count, missing refs)
- [x] GREEN: diagnostics record
- [x] REFACTOR: settle public API, add `export * from "./command-args"` to session barrel, module comment

### Gate 1->2

- [x] All Phase 1 tests pass; `command-args.ts` exported from the session barrel
- [x] Quoting, escaping, 0-based positionals, raw `$ARGUMENTS`, missing-arg empty-string each tested

---

## Phase 2: Host loader + authoritative dispatch (usable slice)

### M3: `.trevor/commands/*.md` loader

- [x] RED: loader reads `<cwd>/.trevor/commands/*.md` -> `CommandFile[]` (`rootKind: "project"`, `id: "/<basename>"`, body frontmatter-stripped)
- [x] GREEN: loader mirroring `skills/skills.ts` ordered-root + frontmatter-strip pattern
- [x] RED: subdirectory recursion, non-`.md` ignored, name from basename
- [x] GREEN: recursion + filter
- [x] RED: user root (config-home) loads; project file overrides same-named user file (D-006)
- [x] GREEN: root ordering + project-over-user precedence
- [x] RED: unreadable/malformed file skipped with structured diagnostic, no crash
- [x] GREEN: fail-soft load with diagnostic
- [x] REFACTOR: loader module comment; share frontmatter parser with `skills.ts` only if clean

### M4: Register + expand-on-dispatch

- [x] RED: a loaded `CommandFile` becomes an invocable command (`commands.ts` `buildCommandRegistry`); `/fix` resolves
- [x] GREEN: register loaded command files into the registry
- [x] RED: `/fix 123` expands via interpolate-then-substitute (D-007) -> `"Fix issue #123"`
- [x] GREEN: wire two-step expansion into dispatch
- [x] RED: expanded text submitted as the turn's `user.message`; `$ARGUMENTS` gets exact raw args
- [x] GREEN: wire expansion output into prompt submission; thread raw args through
- [x] RED: immediate TS slash command still receives raw `args` unchanged (no regression)
- [x] GREEN: confirm substitution path scoped to file-loaded commands only
- [x] REFACTOR: dispatch-boundary comment; confirm web dispatches unknown leading-slash input vs sending literal

### Gate 2->3

- [x] End-to-end: a `.trevor/commands/*.md` file with `$0`/`$1`/`$ARGUMENTS` invokes and submits the expanded prompt (driven via the `verify` skill, not tests alone)
- [x] Immediate TS commands unaffected; interpolation still gated/off-by-default

---

## Phase 3: Web surface (menu listing + live preview)

### M5: Publish custom-command catalog + menu listing

- [x] RED: host publishes the custom-command catalog (id + `argument-hint` + body) over the command-menu contract
- [x] GREEN: catalog publication + web command-menu entries for custom commands
- [x] REFACTOR: reuse existing `command-menu.ts` shapes, no bespoke channel

### M6: Live keystroke preview + Storybook

- [x] RED (story): a Storybook story renders the `/fix 123` substitution preview from a fixture body via `@trevor/session` `expandArgs`
- [x] GREEN: web preview component consuming the shared session module
- [x] RED: `derive.ts` feeds the tokenized preview (dispatch keeps first-space split; preview shows expansion)
- [x] GREEN: wire preview into the composer flow
- [x] REFACTOR: Storybook baselines + a11y; centered story per house style

### Gate 3 (done)

- [x] Custom commands appear in the menu; preview matches host expansion for the same input
- [x] Storybook baselines committed; lint + typecheck + tests green

---

## Deferred follow-up

- **Template-with-no-placeholder auto-append.** Whether a template containing no placeholder
  auto-appends args as a trailing `ARGUMENTS: <value>` line (CC parity). Recommended default: match CC;
  confirm at M2. Open item, not a committed decision.
- **`.claude/commands/` import** (D-009 non-goal) - a later additive root reusing the same engine.
- **`@file` reference resolution** in command bodies - out of scope for 44.5.
