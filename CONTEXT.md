# Trevor - Domain Context

Durable home for cross-cutting domain vocabulary. The former canonical umbrella
(`.plans/trevor-v2/implementation.md` §3) is being retired in favor of the numbered plans; new
cross-plan terms are anchored here. When a term is baked into the protocol, keep it stable.

## Orchestration vocabulary (`.plans/21-workflows-runtime`, `.plans/46-worktree-fleet`)

| Term | Meaning | Notes |
|---|---|---|
| **Workflow** | A deterministic orchestration that spawns subagents in **phases** (sequential, parallel, or pipelined) and folds their results back. | "Deterministic control flow, stochastic leaves." Authored as a built-in/saved module, a model-emitted DSL spec, or (later) sandboxed JS. |
| **Workflow runtime** | The Effect-native engine that executes a workflow: `agent()/parallel()/pipeline()/phase()/log()`, journaling + resume, a budget governor, and worktree-isolated leaves. | `.plans/21-workflows-runtime`. Sits **above** the interactive `delegate_*` tools and owns its own concurrency/depth, distinct from `MAX_DELEGATION_DEPTH=1`. |
| **Workflow spec (DSL)** | A declarative, **model-authored** structured description of a workflow (phases; agents with prompt/schema/model/isolation; deps). | v1 authoring. Interpreted in-process by the runtime; **no code execution, no sandbox**. |
| **Workflow script (JS)** | A later, **sandboxed** JavaScript form of a workflow with arbitrary control flow. | `.plans/21-workflows-runtime` Phase 5, **gated on a shared `sandbox-runner` extracted from `.plans/16-tool-script`**. |
| **Phase** | A named grouping of leaves within a run, for sequencing and progress display. | `phase(title)`. |
| **agent() leaf** | One subagent invocation inside a workflow - the only place the model re-enters. | Reuses `runDelegatedChild` (`apps/agent-host/src/agent/delegate.ts:91`). May be worktree-isolated and write-capable. |
| **Workflow run** | One durable, resumable execution of a workflow, keyed by a `runId` and journaled (`workflow.*` events) on the session log. | Background lifecycle; resume matches `agent()` calls on `(prompt, opts)`. |
| **Fleet** | The built-in `worktree-fleet` workflow + its durable run shell + disposition policy: "implement N plans across N worktrees and audit each." | `.plans/46-worktree-fleet`. The orchestration noun for multi-agent fan-out (**not** "teams"). |
| **Fleet run** | One durable run of the fleet, entered conversationally and handed off to a dedicated, resumable session. | Survives the launching tab closing. |
| **Worker** | A write-capable, worktree-isolated leaf in a fleet run that runs the `planner` skill (implement mode) against one numbered plan. | The fleet parallelizes the planner across managed worktrees. |
| **Auditor (verifier)** | A leaf that adversarially reviews one worker's diff and emits a verdict + findings. | The verifier subagent retained by `.plans/45-subagent-variants` (M2). Distinct from the dropped inline self-validation. |
| **Disposition** | What the fleet does with finished trees: **leave-branches + report** (default), PR-per-tree, or auto-merge clean + passing. | Default writes nothing to base branches; merge stays a human action. |

## Reconciliation with existing terms

- **Subagent / Bounded child** - an `agent()` leaf *is* a subagent / bounded-child run via
  `runDelegatedChild`. The workflow runtime orchestrates leaves; it does not replace the interactive
  `delegate_inline` / `delegate_background` tools, which remain for conversational delegation.
- **Execution mode** (`direct`, `delegate_inline`, `delegate_background`) - a workflow is a *new*
  execution context that orchestrates leaves; it is not one of these modes. The
  `delegate_background` read-only clamp, `MAX_BACKGROUND_CHILDREN_PER_SESSION=4`, and
  `MAX_DELEGATION_DEPTH=1` constrain the **interactive tools**; the runtime owns its own caps and
  lifts the read-only clamp for **worktree-isolated** leaves (the sanctioned unlock once
  `.plans/01-managed-worktree-hardening` lands).
- **Run / Session / Turn** - a workflow run is its own durable session, distinct from a conversational
  turn. A fleet's workers are ordinary child sessions.
- **Fork** - leaves are forkable child sessions (umbrella D-025-D-029), unchanged.

## Dropped term: "teams"

"Teams" (trevor legacy multi-user roster/inbox/DM/audit) is **permanently cut** (umbrella §4, D-003). Do **not**
reintroduce "teams" for multi-agent orchestration. The orchestration nouns are **workflow** (the
engine/pattern) and **fleet** (the worktree application). Likewise, **inline self-validation** is cut
(D-033); a verifier *subagent/auditor leaf* is distinct and allowed.

## Mid-turn switching vocabulary (`.plans/09.1-mid-turn-model-switch`)

| Term | Meaning | Notes |
|---|---|---|
| **Mid-turn switch** | Changing the active model and/or reasoning level *between iterations of one in-flight turn*, not just on the next turn. | Manual via the UI selector now; a future auto-router reuses the same mechanism. |
| **Switch boundary** | The single re-resolution point at the start of each `step(n)` where `runAgent` re-reads the active model+reasoning from a per-turn mutable cell. | Never mid-stream - a switch never interrupts an in-flight `provider.stream` call. The one seam the manual switch and the future auto-router both attach to. |
| **`model.switched`** | The session event recording a switch: `from`/`to` `{model, reasoning}`, `initiator`, and `outcome` (`applied`/`blocked`). | Recorded on the session log so replay reconstructs the active model at every point; rendered as an inline transcript marker. |
| **`initiator`** | Who requested the switch: `manual` now, `auto` (the future router) later. | The field that lets the router reuse the manual switch path. |

A UI-selector switch is **sticky** (it also updates the persisted next-turn selection); a switch toward
a **smaller** context window is **guarded** (refused, `outcome: blocked`, if the conversation would not
fit). A dedicated plan-25 `ModelChange` hook was considered and **dropped**; per-model prompt guidance,
if pursued, belongs in the provider/catalog layer, not a user hook.

## Action-status label vocabulary (`.plans/31-action-shimmer-status`)

The active-turn status is a **shimmering present-progress label** (the `ActionShimmer` primitive,
reusing the `tw-shimmer` overlay idiom + `motion-reduce:animate-none`), not a pulse dot. Its text is
a **deterministic projection** of already-structured transcript/session state - never a fuzzy match
over free-form prose, and never an inference of user intent. The one owner of the vocabulary is the
pure `apps/web/src/action-label.ts` module; tool renderers and the pinned turn-status header (plan 50,
which retired the scrolling working row) read it so they can't drift apart.

| Term | Meaning | Notes |
|---|---|---|
| **Action label** | The short present-progress status shown while a turn/tool is active: `thinking`, `applying steering`, `reading <path>`, `searching <pattern>`, `running <cmd>`, `searching the web`, `reconnecting (attempt n/m)`, `loading <model>`. | Derived from typed fields the host/web already own; rendered as plain readable text with an `aria-hidden` shimmer overlay (announced once, no motion for reduced-motion users). |
| **`FALLBACK_ACTION_LABEL`** (`"Working"`) | The honest default when the event stream gives no better structured evidence. | Preferred over guessing. Projection helpers never return blank and never throw. |
| **Label source priority** | steering → cold-start `loading <model>` → streaming vs. `thinking` for the turn; tool labels come from the salient tool arg (path/pattern/command/query). | An **unknown** tool names itself (`running <name>`) and never runs its args through the summarizer, so raw JSON/secrets can't leak. |
| **Redaction/truncation** | Every dynamic fragment is collapsed to a single short line (`redactLabelFragment`, ≤48 chars, ellipsis). | A multiline or huge tool input can never blow out or leak into the status line. |

No new **host** protocol events were added for labels (D-005): the existing protocol already carries
the structured fields (tool name/args, `assistant.progress` usage, `context.compacting` tokens/budget,
reconnect attempt), so labels are projected web-side.

## Live turn-status header vocabulary (`.plans/50-live-turn-status-header`)

The live indicator for the in-flight turn is a single **`TurnStatusHeader`** line pinned above the task
checklist, mirroring Claude Code's working indicator:
`<action headline>  (<elapsed> · ↓ <output tokens> · <state>)`. It composes existing primitives web-side
(no host/protocol change) and retires the scrolling `working`-row `ActionShimmer` as *the* live indicator.

| Term | Meaning | Notes |
|---|---|---|
| **Turn-status header** | The pinned one-line live turn indicator above the task list: an action headline plus the parenthetical `elapsed · ↓ output-tokens · state`. | The single live turn indicator; replaces the scrolling `working` row. `esc to interrupt` relocates to the pinned region / composer. |
| **Action headline** | The semantic *what*: the in-progress task's `activeForm` (gerund), falling back to `turnActionLabel` when no task is `in_progress`. | Distinct from the trailing state cell (the *how*). Reuses `tasks.current`; no new model output. |
| **`subject` vs `activeForm`** | `subject` = imperative task title shown in the **checklist rows**; `activeForm` = present-progressive form reserved for the **header**. | Both already on `TaskSnapshot`; rows flip from `activeForm` to `subject` so header and row do not duplicate text. |
| **`↓` output-token cell** | Live per-turn **output** tokens (`usage.output`, taken as a monotonic **max** over the live turn's `assistant.progress` snapshots, sharing `liveCallFrom`'s live-turn boundary), `fmtTokens`-abbreviated; resets per turn, hidden until the first `assistant.progress`, never decreases within a turn (R-3). `↓` = streamed down. | Distinct from the `usage-summary` panel (session totals) and from 44.4 `assistant.limit` (rate/quota). |
| **Redundancy rule** | The trailing `state` cell (`turnActionLabel`) renders only when it differs from the headline; when the headline is itself the state, the cell is dropped. | Keeps a no-task line reading `thinking (2m 37s · ↓ 2.6k tokens)` from repeating "thinking". |

The header is a **deterministic web-side projection** (same doctrine as the action-status label): headline
and state come from `activeForm`/`turnActionLabel`, elapsed from `activeTurnStartedAt`, and the token cell
from live `assistant.progress` usage - all already on the session log.

## Durable follow-up queue vocabulary (`.plans/47-durable-follow-up-queue`)

| Term | Meaning | Notes |
|---|---|---|
| **Durable follow-up queue** | The persisted, host-scheduled queue of follow-up `user.message`s submitted while a turn is in flight, each published to the session log at submit time. Replaces the ephemeral browser send queue as the source of truth, so the host drains the whole backlog in order even after the submitting client disconnects. | Drains at 09.1's **switch boundary**. **Not** a workflow/fleet **run** (durable orchestration), and **not** plan 11's local-model **admission queue** - three different "queues"/"durable" things. |
| **Prompt supersession** | A session event naming one or more prior `user.message` `eventId`s as retracted, with an **optional replacement** prompt. The first event-to-event reference in the protocol. | The append-only-log equivalent of removing from the queue. Catch-up runs "**unanswered AND not superseded**". Two producers: Escape-fold (supersede N with a folded replacement) and unqueue (supersede one, no replacement). |
| **Steer-fold** | Collapsing the queued prompts into **one** steering prompt on first Escape. | Distinct from CONTEXT's workflow **result fold-back** (subagents folding results to a parent). Two live meanings of "fold" - this is the send-queue one. |
| **Recall buffer** | A local, capped `localStorage` ring of pulled-out and past prompts, navigated by Up/Down; pulling the newest queued item into the composer emits a durable removal. | **Per-machine, not durable, not roamed across devices.** Pulled items are local-only until re-submitted. Keyed by `sessionId` (pulled slice); a later typed-history follow-on reuses it project-keyed. |

## Supervisor and launcher vocabulary (`.plans/44.1-supervisor-foundation`, `.plans/44.2-browser-folder-sessions`, `.plans/44.3-supervisor-lifecycle-glue`)

Extracted from the residual D-061 "session manager" audit (plan 44, now retired): the pieces needed to
start a folder-bound session from the **web UI**, not just the `trevor` CLI. The premise correction that
drove these terms: `trevor` is a fire-and-exit CLI and the browser reaches only session-store + blob-store,
so there was **no browser-reachable launcher** - hence a supervisor.

| Term | Meaning | Notes |
|---|---|---|
| **Launcher core (`@trevor/launcher`)** | The pure launch orchestration extracted from `apps/trevor-cli`: project-root resolution, session-id derivation/persistence, host reuse/spawn/replace-stale decisions, ownership records, and locks - over an injected platform. | `.plans/44.1`. **One** source of project/session identity + host ownership for the CLI, the supervisor, and (later) the plan-48 desktop core. The CLI keeps only arg parsing / debug / `main.ts`. |
| **Supervisor** | The small long-running local process that subscribes to the reserved **control session** and calls the launcher core on a browser request. The one persistent local actor that can spawn a host on demand, pop the native folder picker, and read the project registry - all answered over the session log. | `.plans/44.1`. Runs as a **fourth ensured shared local service** (alongside session-store / blob-store / web). **"Supervision is not communication"** (shared with `.plans/48` desktop supervisor). **Not** the fleet-run "launcher" of `.plans/46` (an orchestration noun) nor the interactive `delegate_*` path. |
| **Control session** | A reserved session id the supervisor subscribes to; the browser publishes `session.launch.requested` / `folder.pick.requested` / `projects.list.requested` there and reads the matching `*.result` events. | `.plans/44.1`. A pure request/response side-channel modeled on `file.index.requested`/`result`. The **launch result carries the new session's id**; the spawned host announces `host.online` on **its own** session. |
| **Browser-created folder session** | Starting a new folder-bound session from the web UI: sidebar `＋` / `/new` -> picker (recents + host-validated path + native folder icon) -> supervisor launch -> navigate on `host.online`. | `.plans/44.2`. The browser analog of the CLI `trevor` launch and the plan-48 desktop session open. Folder selection is **host-driven** (the browser cannot read the host filesystem; the File System Access API yields no host path). |
| **Native folder pick** | The supervisor shelling out to the OS folder dialog (`osascript choose folder` on macOS) and returning a real POSIX path to fill the picker's path field. | `.plans/44.1` + `.plans/44.2`. **Local-only and best-effort** - the dialog opens on the supervisor's display, so it degrades to paste-a-path when the supervisor is non-local/headless. |
| **Launch state machine** | `idle -> starting -> online \| failed -> (retry) starting`, with stale-host replacement folding into `starting` as a "restarting host…" label. | Introduced happy-path in `.plans/44.2`; extended with `failed`/`retry`/`stale` by `.plans/44.3`. **One** machine shared by the picker and the no-host session-view start, so they can't drift. |
| **Project registry** | The local launcher/supervisor-owned registry of user-visible project folders, keyed by canonical absolute path and stored under `TREVOR_STATE_HOME`. | `.plans/58`. Replaces the legacy one-root-one-session `projects.json` product model. Stores project metadata only (display name/path, collapsed state, recency), never session ids. Browser and future desktop access it through supervisor/launcher APIs, not browser storage. |
| **Session project binding** | The immutable project path attached to a normal session. New sessions publish a durable marker before host startup; legacy sessions derive from `workspace`/`cwd` until touched by new flows. | `.plans/58`. Normal sessions have exactly one project path. `/new` and `/cd <path>` create fresh project-bound sessions; they do not move an existing session between projects. |
| **Project-scoped New Session** | Creating a fresh session id under a selected project path, then navigating to it and starting the host. | `.plans/58`. Supersedes the old app-level recent-project popup as the normal local flow. Add Project records a folder only; New Session is explicit and always project-backed. |

## CLI headless agent surface vocabulary (`.plans/50-cli-headless-agent-surface`)

Making the `trevor` CLI a first-class headless agent surface (like `claude -p` / `codex exec`), not
only a browser-launcher plus a session-addressed `trevor prompt`. The premise: Trevor v2 is purely
client/server - the agent loop lives in the agent-host and is driven over the session log via
`@trevor/sdk`, so a headless one-shot **drives a host**, it does not run the loop in-process (unlike
trevor legacy's in-process `cli/prompt.ts`). Selection plumbing (`ModelRef`, `reasoningLevels`,
`PromptInput.model`) already exists end to end; this plan wires it to CLI flags + defaults.

| Term | Meaning | Notes |
|---|---|---|
| **Headless one-shot (`trevor -p`)** | `trevor -p "…"` resolves the project session, ensures a host online without a browser, runs one turn to completion, and prints the answer (deltas to stderr, final to stdout; `--json` for the turn record). | `.plans/50`. Drives a host via the existing `runPrompt` (`client.prompt` + `streamTurn`), not an in-process agent (D-001). Distinct from the pre-existing session-addressed `trevor prompt <session> <text>`, which needs an already-running host. |
| **Browser-less spawn (`launch({ noBrowser })`)** | A launcher-core option that runs the spawn-or-reuse-host path but skips the two unconditional `openBrowser` calls in `launchInner`, exposing "ensure a host online" as a reusable primitive. | `.plans/50` D-003. The **single seam** shared with the `.plans/48` desktop supervisor (which spawns hosts headlessly too); they must not fork it. `spawnHost` was already fully headless. |
| **Ephemeral session (`--ephemeral`)** | `trevor -p --ephemeral` mints a throwaway session, spawns a host, runs the turn, then tears down - but **only a host this invocation spawned**, never a reused/pre-existing one. | `.plans/50` D-002. Default `-p` instead reuses the project session and leaves the host running (mirrors no-arg `trevor`). Spawn ownership is tracked so teardown can't kill a host a browser tab / supervisor owns. |
| **Catalog read (`client.listCatalog`)** | An SDK read of the host-announced `sources` + `catalogBySource` (per-model `reasoningLevels` / `defaultReasoning`) from presence / `host.online`; `trevor models [--json]` prints it and `--model`/`--reasoning` validation resolves against it. | `.plans/50` D-006. The catalog data (from `~/.pi/auth.json` at host startup) was already on the wire but had no SDK accessor. Needs a live host, so it reuses the browser-less ensure-host-online primitive. |
| **Per-request `--model` / `--reasoning`** | CLI flags on `prompt` / `-p` that build a `ModelRef {sourceId, modelId, reasoning}` in the CLI layer and ride the already-wired `PromptInput.model` path. `--model` is `<sourceId>/<modelId>` (bare modelId only when unambiguous); `--reasoning` is validated against that model's `reasoningLevels`. | `.plans/50` D-004/D-005/D-009. Unknown model / unsupported level **fails fast** with a catalog-derived error pointing at `trevor models` (trevor legacy silently dropped effort to `undefined`). |
| **Config resolver (`config.jsonc`)** | The `${TREVOR_HOME}/config.jsonc` loader + precedence `--flag > TREVOR_MODEL`/`TREVOR_REASONING` env `> config.jsonc file > host-side default` (plan 51 `active ?? default ?? legacy`). | `.plans/50` D-007/D-008/D-011. **Exactly one** loader, shared with `.plans/49`/WS3 (which owns it and is numbered first): whichever of 49-WS3 / 50-M4 lands first builds it, the other extends it (49-WS3 to the full `TREVOR_*` scatter + `trevor init`; 50-M4 to `model`/`reasoning`). Env-wins-over-file matches WS3. |

## Command argument substitution vocabulary (`.plans/44.5-command-arg-substitution`)

User-defined custom commands loaded from `.trevor/commands/*.md` whose body templates carry `$`
placeholders that are expanded on invocation with shell-style tokenization. Parity target: the current
Claude Code skills-doc substitution behavior. **Distinct from plan-40 "interpolation"** - orthogonal
token spaces (`$` vs `!`), see the reconciliation note below.

| Term | Meaning | Notes |
|---|---|---|
| **Argument substitution** | Replacing `$`-placeholders in a command file's body with the invocation's arguments at dispatch. The `$`-space feature. | The shared engine is `packages/session/src/command-args.ts` (`tokenizeArgs` + `expandArgs`), dual-consumed by the host (authoritative) and web (keystroke preview), per the `command-family.ts:10` hoist doctrine. |
| **Positional `$N`** | 0-based positional argument: `$0` = first token, `$1` = second, … | Diverges from trevor legacy (1-based) and shell; chosen for Claude-Code parity (D-001). A reference beyond the provided count substitutes empty string (D-004). |
| **`$ARGUMENTS`** | Expands to the **raw** argument string exactly as typed - quotes and interior whitespace preserved. | Not the tokenized re-join (trevor legacy behavior); positional `$N` use tokenized values, `$ARGUMENTS` stays raw (D-002). |
| **Shell-style tokenizer** | Whitespace splits tokens; single **and** double quotes group + strip; backslash escapes the next char; `\$1` stays literal while `$1` expands. | Richer than `loop-parser.ts` `tokenize()` (double-quote-only regex, no escapes), so a new char-scanning module, not a reuse (D-003). |
| **Custom command file** | A `.trevor/commands/*.md` (project root) or config-home (user root) file; command name = `/<basename>`. Loaded into the plan-40 `CommandFile` primitive (`rootKind` project/user). | Project overrides same-named user file (D-006). Loader mirrors `skills/skills.ts` ordered roots. `.claude/commands/` import is a non-goal (D-009). |
| **No-placeholder auto-append** | When a body carries NO `$` placeholder and the invocation has non-empty args, the raw args are appended as a trailing `ARGUMENTS: <raw>` block. | Claude-Code parity default (the M2 open question, resolved): a placeholder-free command body still receives its input. An escaped `\$0` is literal, not a placeholder, so it does not suppress the append. |
| **Submit branch** | Invoking a custom command SUBMITS its expanded body as the turn's `user.message` prompt (via the control-prompt seam), not a `command.result`. | The load-bearing M4 wiring: a file-loaded command drives the model like a typed prompt; built-in immediate commands keep the `command.result` lane with their raw args. A built-in name always wins over a same-named file. |
| **Live preview** | The web renders the substitution live past the first space (`/fix ‹args›`), complementary to the slash menu (which closes on that space). | Reuses the shared `expandArgs`; the command `body` + `argumentHint` ride `CommandSpec` on `host.online` so the preview matches host expansion (M5/M6). |

### Reconciliation with "interpolation" (plan 40)

- **Argument substitution (`$`) is NOT interpolation (`!`).** Plan-40 **interpolation** splices the
  *output* of an allow-listed `!command` into a trusted command-file body (gated by
  `TREVOR_ENABLE_INTERPOLATION`, disabled by default). Plan-44.5 **argument substitution** replaces
  `$`-placeholders with the user's invocation arguments. Different trigger tokens, different sources
  (command output vs user args), different modules (`interpolation-engine.ts` vs `command-args.ts`).
- **Ordering is fixed: interpolate, then substitute (D-007).** A command file's trusted body is
  interpolated first (author-controlled `!command` sites), then user arguments are substituted into the
  result - so a user-supplied `$0` value containing `!cmd` lands as inert literal text and can never
  introduce an interpolation site.

## Project sidebar vocabulary (`.plans/58-project-sidebar-sessions`)

The left sidebar is a project-first navigation surface. A **project** is a user-visible folder record
keyed by canonical absolute path, stored as local launcher/supervisor state under `TREVOR_STATE_HOME`
(not a session-store row, not browser storage). Sessions remain durable session-store logs; project
membership is a join over the session inventory by each session's resolved project path, never a
duplicated list stored on the project record.

| Term | Meaning | Notes |
|---|---|---|
| **Project registry** | Canonical-path-keyed project metadata (display name, collapsed state, timestamps) with NO session ids. Stored as `project-registry.json` under `TREVOR_STATE_HOME`. | `packages/launcher/src/project-registry.ts`. Replaces the old one-root-one-session `projects.json` (kept only for migration). CRUD lives in the launcher; the supervisor exposes it over the control session. |
| **Project-scoped session** | A session bound to one immutable project path for its whole life. `/cd` and `/new <path>` create a FRESH session instead of moving the current one. | Fresh context is a real new session, never an in-place clear. The `session.project` marker stamps the binding durably. |
| **`session.project` marker** | The durable, immutable project-path marker on a session log: wins over `host.online` workspace/cwd for resolving a session's project path. | Plan 58 M3. Lets the sidebar/archive group sessions without a live host. Folded into `SessionSummary.projectPath`. |
| **Project sidebar read model** | A pure projection: groups active (non-archived, non-deleted, non-tangent) sessions under their project by resolved project path, merging known registry records with transient projects (sessions whose path has no record). | `apps/web/src/sidebar/project-sidebar-model.ts` (`buildProjectSidebar`). The browser owns it; it never scans local state. Lists ALL projects, not just the current one. |
| **Transient project** | A project with active sessions but no registry record. Surfaced as a group using the path basename as the display name. | Live work stays visible even without a saved record (D-004). |
| **Archive-only project** | A registry project with no active sessions (all its sessions are archived). The sidebar renders a "View archive" link that opens the archive browser filtered to that project's path. | Plan 58 M7. Delete stays in the archive browser only; the normal sidebar offers Archive, never Delete. |

### Reconciliation with existing terms

- **Project registry is NOT `projects.json`.** The legacy `projects.json` mapped root -> single
  session id (one stable session per root). The registry stores metadata only (no session ids);
  membership is derived from the session inventory + `session.project`. The legacy file is read once
  for migration, then the registry is the source of truth.
- **`/new` is NOT `/clear`.** `/clear` is retired from visible command surfaces (plan 58 M4); its
  programmatic host handler stays for replay compatibility with legacy sessions. `/new` (and its alias
  `/cd <path>`) mint a fresh project-scoped session with a new id and a `session.project` marker.
- **Project identity is canonical path.** The browser never canonicalizes; the supervisor/launcher
  returns the canonical path and display path. A normal session has one immutable project path.

## assistant-ui dependency governance (`.plans/58.6.1-assistant-ui-audit-followups`)

Trevor **owns copies** of the assistant-ui components it uses (vendored under
`apps/web/src/components/assistant-ui/`); it does **not** run the assistant-ui runtime (`AssistantRuntimeProvider`,
`ExternalStore`, thread adapters). The durable session log + host turn loop + transcript projection are the
source of truth (58.6 D-002), so the coupling to the upstream packages is small and **deliberately pinned to
exact versions** - a bump is a reviewed action, never a silent transitive drift. This retires the 58.6 audit's
"unstable API churns after adoption" risk (rows E10/G8/G9/D6/C7).

### Exact pins

| Package | Pin | Section | Why |
|---|---|---|---|
| `@assistant-ui/react` | `0.14.23` (exact, no caret) | `dependencies` | Live **runtime** imports (`useScrollLock`, `useAui`). |
| `@assistant-ui/react-markdown` | `0.14.4` (exact, no caret) | `devDependencies` | **Type-only** after the M1 prune (one `SyntaxHighlighterProps` type in `diff-viewer.tsx`); erased at build. |

`remark-gfm` was removed entirely in M1 - its sole user was the deleted second markdown stack
(`markdown-text.tsx`). The live markdown everywhere is the `marked` + DOMPurify stack in `src/markdown.tsx`
(`MarkdownBody`), never assistant-ui's `MarkdownText`.

### Live coupling ledger (every reference into the pinned packages)

| Import | Kind | Site | Stability tier |
|---|---|---|---|
| `useScrollLock` | runtime hook | `assistant-ui/use-collapsible-disclosure.ts:3` (live via `chat/reasoning-trace.tsx` → `ReasoningGroup`) | **T1 runtime** - a bump can change behavior; guarded by the reasoning-trace render smoke tests. |
| `useAui` | runtime hook | `assistant-ui/model-selector.tsx:18` (Storybook-only today) | **T1 runtime**, dormant surface. |
| `ToolCallMessagePartStatus` | type-only | `chat/tool-status.ts:1`, `assistant-ui/tool-fallback.tsx:10` | **T2 type** - compile-time only; a bump surfaces at `pnpm --filter web typecheck`. |
| `SyntaxHighlighterProps` | type-only | `assistant-ui/diff-viewer.tsx:4` | **T2 type** - compile-time only; guarded by the diff-viewer render smoke tests. |
| Vendored components | owned copy | `apps/web/src/components/assistant-ui/*` | **T3 owned** - our source; upstream changes reach us only through a deliberate re-vendor (the drift check below), never automatically. |

### Guards (survive a version bump)

- **Render smoke tests** (the durable deliverable): `assistant-ui/diff-viewer.test.tsx`,
  `chat/diff-render-smoke.test.tsx`, and the existing `chat/reasoning-trace.test.tsx` assert the STRUCTURAL
  output (data-slots, add/del line typing, the reasoning disclosure) of the assistant-ui-derived surfaces -
  not styling - so a bump that breaks the render fails at review time.
- **Vendored-component drift check**: `pnpm --filter @trevor/web check:assistant-ui-drift` runs
  `apps/web/scripts/assistant-ui-drift.sh`, an `assistant-ui add --dry` dry-run over the vendored files, so an
  upstream change to a component we copied is visible before we adopt it. It is a review aid, not a CI gate.
- **Update path**: to bump, change the exact pin, run `pnpm install`, run the render smoke tests + the drift
  check, reconcile any vendored-component diffs by hand, and update this ledger. Never widen a pin back to a
  caret.
