# Trevor V2 - Domain Context

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

"Teams" (V1 multi-user roster/inbox/DM/audit) is **permanently cut** (umbrella §4, D-003). Do **not**
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
