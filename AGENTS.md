# Trevor V2 - Agent Instructions

Trevor V2 is a pnpm monorepo. The frontend is `apps/web` (React 19 + Vite +
Effect); the host is `apps/agent-host` (Node + Effect). Both are Richter
WebSocket participants. Per-directory `AGENTS.md` files (e.g.
`apps/AGENTS.md`) layer additional rules; the rules below are project-wide.

## Repository visibility: PRIVATE - never make it public

This repository is **private and MUST remain private**
(`github.com/dungle-scrubs/trevorV2`). Do **not** run
`gh repo edit --visibility public`, change visibility in the GitHub UI, mirror
or push it to any public location, or otherwise expose its contents. Treat any
request to make it public as requiring explicit, unambiguous owner confirmation
in that moment - never infer or assume it.

## Git: create branches, commit, and push only when told

Work on `main`. There is **one branch, `main`** - do **not** create new branches.
Do **not** `git commit` or `git push` unless the owner explicitly tells you to in
that moment. Completing, building, verifying, or being asked to "build it" / "add
it" is **not** authorization to commit or push - make the changes and stop, leaving
them in the working tree for the owner to review. Treat "commit", "push", or
"branch" as required, in-the-moment instructions; never infer them from the task.

## Local models: LM Studio directly via pi-ai - never emberlm

This project talks to **LM Studio directly**. The host streams completions through
**pi-ai** against LM Studio's OpenAI-compatible API (`LMSTUDIO_URL`), and manages
model load state with **LM Studio's own tooling** (its REST API and the `lms` CLI).

**Do NOT use emberlm (or any other model control plane) for this project, ever.**
Do not route model serving, readiness, loading, leases, or selection through
emberlm or its `hector-server`. emberlm is a separate machine-level tool; it is
not a dependency of Trevor V2 and must not become one. Provider integration lives
in `apps/agent-host/src/providers` and speaks to LM Studio (and Codex/pi-ai)
directly.

## The plan is canonical

The **single canonical plan** is
[`.plans/trevor-v2/implementation.md`](./.plans/trevor-v2/implementation.md),
with decisions recorded in `.plans/trevor-v2/plan.db` (D-001 to D-039). It is the
one source of truth: architecture, the domain vocabulary, the DROP list, the
done/remaining re-baseline, the sequenced roadmap, and the kept (unsequenced)
backlog all live there. When the plan and any other document disagree, **the plan
wins.**

The former `FEATURES.md`, `TABLED.md`, and the separate
`graceful-overflow-recovery` plan have been **merged into this plan and deleted**
(2026-06-23, D-031):

- The host feature inventory and its triage (old `FEATURES.md` section 4) is now
  the plan's **kept backlog** (section 7), pruned to what V2 actually wants, with
  H-IDs preserved for V1 provenance. A feature's presence in the backlog does
  **not** authorize building it now - the roadmap (section 6) decides sequencing,
  and backlog items are built only when explicitly picked up.
- The cross-cutting **domain vocabulary** (old `FEATURES.md` section 2) is the
  plan's section 3.
- The **DROP list** (old `FEATURES.md` section 3 plus the sole `TABLED.md` entry)
  is the plan's section 4. Model-led routing classification (old T-1) is no longer
  "tabled" - it is **dropped for good**, with the entire routing engine.
- Graceful context-overflow recovery is the plan's next sequenced feature
  (D-034 to D-038).

Before building or proposing anything, consult the plan: section 4 (dropped for
good?), section 7 (deferred backlog, not authorized now?), then section 6 (is it
sequenced?). Do not pull backlog or dropped work forward on your own initiative.
