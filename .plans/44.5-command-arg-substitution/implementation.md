# Command Argument Substitution - Implementation Plan (plan 44.5)

Custom slash commands loaded from `.trevor/commands/*.md` whose body templates carry
`$0`/`$1`/`$ARGUMENTS` placeholders, expanded on invocation with shell-style argument
tokenization. Parity target: the current Claude Code skills-doc substitution behavior.

## 0. Hard Dependencies

<!-- D-006 --> This plan builds directly on the **command-file subsystem** shipped by the completed
plan 40 (`command-shell-interpolation`), which is merged to `main` and has **no live branch**:

- `apps/agent-host/src/commands/command-file.ts` - the `CommandFile` primitive (`id` / `rootKind` /
  `body`), the `CommandFileRootKind` trust contract (`builtin` | `project` | `user` | `untrusted`),
  and `expandCommandFile()` (gated `!command` interpolation). This primitive shipped **unwired** - no
  disk loader, no caller. 44.5 wires it.
- The plan-40 interpolation primitives (`interpolation.ts`, `interpolation-engine.ts`) stay untouched;
  substitution is a **separate** operation layered after interpolation (see D-007).

No dependency on any plan with a live feature branch (only `feat/44.4-usage-limit-events` is live, and
44.5 sits after it in number order).

**Downstream assessment (plans threaded: none).** <!-- D-011 --> 44.5 lands before plans 46-50 in number
order, so its assumptions were checked against the later plans. **46-worktree-fleet** reuses `/worktree-*`
commands *programmatically* (`makeWorktreeCommands`, direct handler calls) - that path does not go through
file-loaded command-body substitution, so no interaction. **49-open-source-launch-readiness** consolidates
the *global* `${TREVOR_HOME}/config.jsonc` + env vars (WS3) and guards the public surface (WS2); a
project-local `.trevor/commands/` root sits alongside `.trevor/rules` / `.trevor/hooks.json` and changes
no contract 49 relies on (49 is an explicit terminal capstone, its D-006). Both considered; neither
threaded. Immediate TS slash commands keep receiving their raw `args` unchanged (D-007), so no existing
command plan's assumptions move.

---

## Architecture

A three-layer vertical slice. The pure substitution **engine** is shared; the **host** owns the
authoritative loader + dispatch; the **web** adds discoverability and a live preview.

```
.trevor/commands/fix.md            packages/session/src/command-args.ts        apps/web
   "Fix issue #$0"          ──►     tokenize(raw) + expandArgs(tmpl, raw)   ◄── live keystroke preview
        │                                     ▲                                  (command menu + preview)
        ▼                                     │ same module, both sides
   host loader → CommandFile ──► expandCommandFile (interpolate, D-007 first)
                                     └─► expandArgs (substitute, D-007 second) ──► submitted prompt
```

- **Layer 1 - engine (`packages/session/src/command-args.ts`, new).** <!-- D-005 --> A pure,
  dependency-free tokenizer + substituter, exported from the session barrel and consumed by **both**
  the web (keystroke preview) and the host (authoritative expansion), following the documented
  `command-family.ts:10` hoist doctrine and the already-hoisted `loop-parser.ts` precedent.
- **Layer 2 - host (`apps/agent-host/src/commands/`).** A `.trevor/commands/*.md` loader that produces
  `CommandFile`s, registration of each as an invocable command (name = `/<basename>`), and
  expand-on-dispatch: `expandCommandFile` (interpolation) **then** `expandArgs` (substitution).
- **Layer 3 - web (`apps/web/src/`).** The host publishes the custom-command catalog; the command menu
  lists the commands and a live preview renders the substitution using the Layer-1 module.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| <!-- D-001 --> 0-based positional indexing (`$0` = first arg) | Diverges from V1 Trevor (1-based) and from shell muscle memory; the substituter maps `$N` -> `tokens[N]`. |
| <!-- D-002 --> `$ARGUMENTS` = raw string as typed | The engine must retain the raw argument string alongside the tokenized list; `$ARGUMENTS` never uses the re-joined tokens. |
| <!-- D-003 --> Shell-style quoting + backslash escapes | Single **and** double quotes group + strip; `\` escapes the next char; `\$1` stays literal while `$1` expands. Richer than `loop-parser.ts` (double-quote-only regex, no escapes) -> a new char-scanning module. |
| <!-- D-004 --> Missing-arg -> empty string | `$2` with one arg passed substitutes `""` - no literal `$2` leak, no throw. |
| <!-- D-007 --> Interpolate-then-substitute | Ordering is fixed so user arg values can never introduce interpolation sites. |
| <!-- D-008 --> Named distinctly from "interpolation" | The `$`-placeholder feature is **argument substitution**; the plan-40 `!command` feature stays **interpolation**. Orthogonal token spaces. |
| <!-- D-009 --> `.trevor/commands/` only | Reading `.claude/commands/` for CC-file import is a non-goal (future additive root). |

### Boundaries

- **`command-args.ts` owns tokenization + substitution only.** It does not read disk, does not
  interpolate `!command` sites, does not dispatch. Public surface (target shape): `tokenizeArgs(raw)`
  -> tokens; `expandArgs(template, raw)` -> `{ text, diagnostics }`. A module-level comment states what
  it owns and why it is distinct from `interpolation-engine.ts`.
- **The host loader owns disk read + trust-root assignment**, reusing `CommandFileRootKind` (`project`
  for `<cwd>/.trevor/commands/`, `user` for the config-home root). It mirrors the existing disk-root
  loader pattern in `apps/agent-host/src/skills/skills.ts` (ordered roots, frontmatter strip), not a
  new bespoke scanner.
- <!-- D-007 --> **`expandCommandFile` (interpolation) stays exactly as-is.** Substitution is a
  **separate** call applied to its output: `expandArgs(expandCommandFile(body).text, rawArgs)`. The
  trusted, author-controlled body is interpolated first (gated, in-process, allow-listed); the
  user-supplied args are substituted into the result, so a `$0` value containing `!cmd` lands as inert
  literal text.
- **Immediate TypeScript slash commands are unaffected.** They still receive the raw `args` string in
  their `run(args, input)` and parse it ad hoc; substitution applies **only** to file-loaded command
  bodies. The web keeps parsing on keystroke; the host remains authoritative.

### Observability

Substitution itself is pure and deterministic, so the observability surface is small and lives at the
two runtime boundaries:

- **Loader:** a structured, redaction-safe diagnostic when a command file fails to load (unreadable,
  bad frontmatter) - the file is skipped, never crashes registration, and the reason is answerable.
- **Expansion:** `expandArgs` returns a light diagnostic record (which placeholders were referenced,
  how many args were provided, which references defaulted to empty via D-004) so "why did my command
  expand to that?" is inspectable at the dispatch boundary and in the web preview. This mirrors the
  existing `InterpolationDiagnostic` shape without reusing it (different feature).

---

## Phases

### Phase 1: Substitution engine (`@trevor/session`)

**Goal:** a pure, fully-tested `command-args` module exists in `packages/session/src/`, exported from
the barrel, with no host or web wiring yet.

#### M1: Shell-style tokenizer

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: failing test - `tokenizeArgs("a b c")` -> `["a","b","c"]` (whitespace split).
  2. GREEN: char-scanning whitespace tokenizer.
  3. RED: double-quoted span is one token, quotes stripped - `'"two words" x'` -> `["two words","x"]`.
  4. GREEN: double-quote grouping.
  5. RED: single-quoted span likewise - `"'two words' x"` -> `["two words","x"]`.
  6. GREEN: single-quote grouping.
  7. RED: backslash escapes - `"a\\ b"` -> `["a b"]`; `'\\"x'` -> `['"x']` (escaped quote is literal).
  8. GREEN: backslash escape handling in the scanner.
  9. RED: unterminated quote -> defined behavior (consume to end of input) plus a diagnostic flag.
  10. GREEN: unterminated-quote handling.
  11. REFACTOR: extract the char-scanner, name the scan states, add the module-level comment
      distinguishing this module from `interpolation-engine.ts`.

#### M2: Substituter + public API

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: `expandArgs("#$0 $1", "a b")` -> `"#a b"` (<!-- D-001 --> 0-based positional).
  2. GREEN: positional `$N` -> `tokens[N]` substitution.
  3. RED: `$ARGUMENTS` expands to the **raw** string as typed - `expandArgs('x $ARGUMENTS', '"a b"  c')`
     keeps `"a b"  c` verbatim (<!-- D-002 -->), while `$0` on the same input is `a b`.
  4. GREEN: raw `$ARGUMENTS` expansion (raw string carried separately from tokens).
  5. RED: missing-arg -> empty string - `expandArgs("[$2]", "only")` -> `"[]"` (<!-- D-004 -->).
  6. GREEN: out-of-range positional -> `""`.
  7. RED: escaped placeholder - `expandArgs("\\$1 $1", "v")` -> `"$1 v"` (`\$1` literal, `$1` expands);
     `\\\\$1` -> backslash + expansion (<!-- D-003 -->).
  8. GREEN: escape-aware substitution pass.
  9. RED: `expandArgs` returns a `{ text, diagnostics }` result exposing referenced placeholders,
     provided-arg count, and missing references.
  10. GREEN: diagnostics record.
  11. REFACTOR: settle the public API (`tokenizeArgs`, `expandArgs`, result type), add
      `export * from "./command-args"` to `packages/session/src/index.ts`, module comment.

**Open question (resolve at implementation, recommend CC-parity default):** when a template contains
**no** placeholder at all, Claude Code auto-appends the args as a trailing `ARGUMENTS: <value>` line.
Recommended default: match that behavior; confirm before wiring. Tracked as a Phase-1 open item, not a
committed decision.

### Gate 1->2

- [ ] All Phase 1 tests pass; `command-args.ts` exported from the session barrel.
- [ ] `tokenizeArgs` / `expandArgs` cover quoting, escaping, 0-based positionals, raw `$ARGUMENTS`, and
      missing-arg empty-string, each with a test.

### Phase 2: Host loader + authoritative dispatch (usable slice)

**Goal:** dropping `.trevor/commands/fix.md` containing `Fix issue #$0` and invoking `/fix 123`
submits `Fix issue #123` as the turn's prompt - end-to-end, without any web menu work.

#### M3: `.trevor/commands/*.md` loader

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: loader reads `<cwd>/.trevor/commands/*.md`, returns `CommandFile[]` with `rootKind: "project"`,
     `id: "/<basename>"`, `body` = frontmatter-stripped content.
  2. GREEN: loader mirroring the `skills/skills.ts` ordered-root + frontmatter-strip pattern.
  3. RED: subdirectory recursion, non-`.md` files ignored, name derived from basename.
  4. GREEN: recursion + filter.
  5. RED: user root (config-home `commands/`) also loads; a project file **overrides** a user file of
     the same name (<!-- D-006 -->).
  6. GREEN: root ordering + project-over-user precedence.
  7. RED: an unreadable / malformed file is skipped with a structured diagnostic, not a crash.
  8. GREEN: fail-soft load with diagnostic.
  9. REFACTOR: module-level comment on the loader (what it owns, trust-root assignment), share the
     frontmatter parser with `skills.ts` only if it stays clean.

#### M4: Register + expand-on-dispatch

- **Dependencies:** M3, M2
- **Effort:** M
- **Tasks:**
  1. RED: a loaded `CommandFile` becomes an invocable command in the host registry (`commands.ts`
     `buildCommandRegistry`), so `/fix` resolves.
  2. GREEN: register loaded command files into the registry.
  3. RED: dispatching `/fix 123` expands the body via **interpolate-then-substitute** (<!-- D-007 -->):
     `expandArgs(expandCommandFile(body).text, "123")` -> `"Fix issue #123"`.
  4. GREEN: wire the two-step expansion into dispatch.
  5. RED: the expanded text is submitted as the turn's `user.message` (end-to-end through
     `main.ts` dispatch), and `$ARGUMENTS` receives the exact raw argument string from the invocation.
  6. GREEN: wire expansion output into prompt submission; thread the raw args through.
  7. RED: an immediate TypeScript slash command still receives its raw `args` unchanged (no regression).
  8. GREEN: confirm the substitution path is scoped to file-loaded commands only.
  9. REFACTOR: dispatch-boundary comment; ensure the web's leading-slash input dispatches an unknown
     custom command rather than sending it as a literal prompt (confirm `parseCommand` behavior).

### Gate 2->3

- [ ] End-to-end: a `.trevor/commands/*.md` file with `$0`/`$1`/`$ARGUMENTS` invokes and submits the
      expanded prompt (verified by driving the host, per the `verify` skill - not tests alone).
- [ ] Immediate TS commands unaffected; interpolation still gated/off-by-default.

### Phase 3: Web surface (menu listing + live preview)

**Goal:** custom commands are discoverable in the command menu and typing shows a live substitution
preview. This is the polish layer; Phase 2 already makes the feature usable.

#### M5: Publish custom-command catalog + menu listing

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: the host publishes the custom-command catalog (id + `argument-hint` + body) to the web over
     the existing command-menu contract.
  2. GREEN: catalog publication + web command-menu entries for custom commands.
  3. REFACTOR: reuse the existing `command-menu.ts` shapes; no bespoke channel.

#### M6: Live keystroke preview + Storybook

- **Dependencies:** M5, M2
- **Effort:** M
- **Tasks:**
  1. RED (story): a Storybook story renders the substitution preview for `/fix 123` from a fixture
     command body, using the `@trevor/session` `expandArgs` module.
  2. GREEN: the web preview component consuming the shared session module.
  3. RED: `derive.ts` feeds the tokenized preview (dispatch still uses the first-space name/args split;
     the preview shows the expansion).
  4. GREEN: wire the preview into the composer flow.
  5. REFACTOR: Storybook baselines + a11y; centered story per house style.

### Gate 3 (done)

- [ ] Custom commands appear in the menu; the preview matches host expansion for the same input.
- [ ] Storybook baselines committed; lint + typecheck + tests green.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Web sends `/customcmd ...` as a literal prompt instead of dispatching (unknown to web) | med | med | M4 task 9 confirms `parseCommand` treats any leading-slash input as a command; host dispatch is authoritative even without the menu catalog | impl |
| Arg value injects an interpolation site | high | low | <!-- D-007 --> interpolate-then-substitute ordering makes it structurally impossible; covered by a Phase-2 test | impl |
| "interpolation" vs "argument substitution" naming confusion | low | med | <!-- D-008 --> distinct module + CONTEXT.md vocabulary; module comments cross-reference | impl |
| Frontmatter parser divergence from `skills.ts` | low | med | Reuse `skills.ts` frontmatter parse if it stays clean; otherwise a small local strip, tested | impl |

---

## Non-Goals

- <!-- D-009 --> Reading `.claude/commands/` for Claude-Code-file compatibility. Future additive root.
- Expanding the `CommandFile` frontmatter contract (model override, allowed-tools richness) beyond what
  the shipped primitive already supports.
- `@file` reference resolution and `!`-shell interpolation **as new work** - interpolation already
  exists (plan 40) and is reused as-is; `@file` refs are out of scope for 44.5.
- Nested slash-command argument expansion (a `/cmd` whose arg is itself a `/cmd`).

---

## Validation Commands

```bash
# Session engine unit tests
pnpm --filter @trevor/session test command-args

# Host loader + dispatch tests
pnpm --filter @trevor/agent-host test command

# Web preview stories/tests
pnpm --filter @trevor/web test command
pnpm --filter @trevor/web storybook   # visual check of the preview

# Full gate
pnpm lint && pnpm typecheck && pnpm test
```

(Exact filter names to be confirmed against the workspace during M1.)

---

## Decisions

Canonical decisions live in `.plans/44.5-command-arg-substitution/plan.db`. Query with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts \
  query-decisions --plan "44.5-command-arg-substitution"
```

D-001 0-based indexing · D-002 raw `$ARGUMENTS` · D-003 shell-style quoting + escapes · D-004
missing-arg empty · D-005 session-package home · D-006 `.trevor/commands/` + `CommandFile` reuse ·
D-007 interpolate-then-substitute · D-008 naming distinct from interpolation · D-009 `.claude/` compat
non-goal · D-010 numbering 44.5.
