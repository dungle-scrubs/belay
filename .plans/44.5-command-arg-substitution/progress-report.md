# Command Argument Substitution - Progress Report (plan 44.5)

Implementation resume state for plan 44.5. RED/GREEN/REFACTOR task tracking per milestone.

**Stage:** ready (not started)

> **Current focus:** Phase 1 · M1 - RED: `tokenizeArgs("a b c")` -> `["a","b","c"]`

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks | 54 |
| Checked (done) | 0 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

Milestones: M1-M6 (6) across 3 phases. All current-cutoff at authoring time; no
deferred or superseded checklist debt. Phase 2 (M3-M4) delivers the usable slice;
Phase 3 (M5-M6) is the web preview polish.

---

## Phase 1: Substitution engine (`@trevor/session`)

### M1: Shell-style tokenizer

- [ ] RED: `tokenizeArgs("a b c")` -> `["a","b","c"]` (whitespace split)
- [ ] GREEN: char-scanning whitespace tokenizer
- [ ] RED: double-quoted span -> one token, quotes stripped (`"two words" x`)
- [ ] GREEN: double-quote grouping
- [ ] RED: single-quoted span -> one token, quotes stripped
- [ ] GREEN: single-quote grouping
- [ ] RED: backslash escapes (`a\ b` -> `["a b"]`; `\"x` -> `['"x']`)
- [ ] GREEN: backslash escape handling in the scanner
- [ ] RED: unterminated quote -> consume-to-end + diagnostic flag
- [ ] GREEN: unterminated-quote handling
- [ ] REFACTOR: extract char-scanner, name scan states, module comment vs `interpolation-engine.ts`

### M2: Substituter + public API

- [ ] RED: `expandArgs("#$0 $1", "a b")` -> `"#a b"` (0-based, D-001)
- [ ] GREEN: positional `$N` -> `tokens[N]`
- [ ] RED: `$ARGUMENTS` raw as typed (`'"a b"  c'` preserved); `$0` on same input = `a b` (D-002)
- [ ] GREEN: raw `$ARGUMENTS` expansion (raw string carried separately from tokens)
- [ ] RED: missing-arg -> empty string (`[$2]` with one arg -> `[]`, D-004)
- [ ] GREEN: out-of-range positional -> `""`
- [ ] RED: escaped placeholder (`\$1 $1` -> `$1 v`; `\\$1` -> backslash + expansion, D-003)
- [ ] GREEN: escape-aware substitution pass
- [ ] RED: `expandArgs` returns `{ text, diagnostics }` (referenced placeholders, arg count, missing refs)
- [ ] GREEN: diagnostics record
- [ ] REFACTOR: settle public API, add `export * from "./command-args"` to session barrel, module comment

### Gate 1->2

- [ ] All Phase 1 tests pass; `command-args.ts` exported from the session barrel
- [ ] Quoting, escaping, 0-based positionals, raw `$ARGUMENTS`, missing-arg empty-string each tested

---

## Phase 2: Host loader + authoritative dispatch (usable slice)

### M3: `.trevor/commands/*.md` loader

- [ ] RED: loader reads `<cwd>/.trevor/commands/*.md` -> `CommandFile[]` (`rootKind: "project"`, `id: "/<basename>"`, body frontmatter-stripped)
- [ ] GREEN: loader mirroring `skills/skills.ts` ordered-root + frontmatter-strip pattern
- [ ] RED: subdirectory recursion, non-`.md` ignored, name from basename
- [ ] GREEN: recursion + filter
- [ ] RED: user root (config-home) loads; project file overrides same-named user file (D-006)
- [ ] GREEN: root ordering + project-over-user precedence
- [ ] RED: unreadable/malformed file skipped with structured diagnostic, no crash
- [ ] GREEN: fail-soft load with diagnostic
- [ ] REFACTOR: loader module comment; share frontmatter parser with `skills.ts` only if clean

### M4: Register + expand-on-dispatch

- [ ] RED: a loaded `CommandFile` becomes an invocable command (`commands.ts` `buildCommandRegistry`); `/fix` resolves
- [ ] GREEN: register loaded command files into the registry
- [ ] RED: `/fix 123` expands via interpolate-then-substitute (D-007) -> `"Fix issue #123"`
- [ ] GREEN: wire two-step expansion into dispatch
- [ ] RED: expanded text submitted as the turn's `user.message`; `$ARGUMENTS` gets exact raw args
- [ ] GREEN: wire expansion output into prompt submission; thread raw args through
- [ ] RED: immediate TS slash command still receives raw `args` unchanged (no regression)
- [ ] GREEN: confirm substitution path scoped to file-loaded commands only
- [ ] REFACTOR: dispatch-boundary comment; confirm web dispatches unknown leading-slash input vs sending literal

### Gate 2->3

- [ ] End-to-end: a `.trevor/commands/*.md` file with `$0`/`$1`/`$ARGUMENTS` invokes and submits the expanded prompt (driven via the `verify` skill, not tests alone)
- [ ] Immediate TS commands unaffected; interpolation still gated/off-by-default

---

## Phase 3: Web surface (menu listing + live preview)

### M5: Publish custom-command catalog + menu listing

- [ ] RED: host publishes the custom-command catalog (id + `argument-hint` + body) over the command-menu contract
- [ ] GREEN: catalog publication + web command-menu entries for custom commands
- [ ] REFACTOR: reuse existing `command-menu.ts` shapes, no bespoke channel

### M6: Live keystroke preview + Storybook

- [ ] RED (story): a Storybook story renders the `/fix 123` substitution preview from a fixture body via `@trevor/session` `expandArgs`
- [ ] GREEN: web preview component consuming the shared session module
- [ ] RED: `derive.ts` feeds the tokenized preview (dispatch keeps first-space split; preview shows expansion)
- [ ] GREEN: wire preview into the composer flow
- [ ] REFACTOR: Storybook baselines + a11y; centered story per house style

### Gate 3 (done)

- [ ] Custom commands appear in the menu; preview matches host expansion for the same input
- [ ] Storybook baselines committed; lint + typecheck + tests green

---

## Deferred follow-up

- **Template-with-no-placeholder auto-append.** Whether a template containing no placeholder
  auto-appends args as a trailing `ARGUMENTS: <value>` line (CC parity). Recommended default: match CC;
  confirm at M2. Open item, not a committed decision.
- **`.claude/commands/` import** (D-009 non-goal) - a later additive root reusing the same engine.
- **`@file` reference resolution** in command bodies - out of scope for 44.5.
