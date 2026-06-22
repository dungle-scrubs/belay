# Trevor V2 - Agent Instructions

Trevor V2 is a pnpm monorepo. The frontend is `apps/web` (React 19 + Vite +
Effect); the host is `apps/agent-host` (Node + Effect). Both are Richter
WebSocket participants. Per-directory `AGENTS.md` files (e.g.
`apps/web/AGENTS.md`) layer additional rules; the rules below are project-wide.

## The plan is canonical; FEATURES.md and TABLED.md serve it

The **current plan** is [`.plans/host-rebuild/implementation.md`](./.plans/host-rebuild/implementation.md),
with canonical decisions recorded in `.plans/host-rebuild/plan.db` (D-001 to
D-020). When the plan and any other document disagree, **the plan wins** - the
2026-06-22 browser/Richter pivot superseded the original Rust-TUI / stdio
design, and much of the older material is historical context behind a
superseding header.

[FEATURES.md](./FEATURES.md) and [TABLED.md](./TABLED.md) are read **in relation
to the plan**, not on their own:

- **[FEATURES.md](./FEATURES.md) is the backlog, scoped by the plan.** Its
  section 4 host inventory (H-001 through H-175) is the valid post-S3 feature
  backlog, re-sequenced onto the Richter transport. Use it to find *what* a
  feature was and where it lived in the old host. **Ignore its superseded
  sections** (0, 1, 5, 6, 7: prime directive, host-TUI stdio contract, TUI
  inventory, protocol appendix, TUI slice order) - there is no Rust TUI, the
  transport is Richter-participant WebSocket, and the slice order is browser-
  first (S0 -> S1 -> S2 -> S3) as defined in the plan, not FEATURES.md section 7.
  A feature's presence in FEATURES.md does not authorize building it now; the
  plan's phases and slices decide sequencing.

- **[TABLED.md](./TABLED.md) is the deliberately-set-aside list.** Before
  building or proposing anything, check it: a tabled feature (e.g. T-1 model-led
  routing classification, D-004) is **not** on the active burndown and must not
  be revived unless its recorded reconsider-trigger is met or the user asks.
  Tabled is distinct from dropped - FEATURES.md section 3 DROP (multi-user /
  collaboration, D-003) is permanent removal; TABLED.md is "revisit
  deliberately later." Do not pull tabled work forward on your own initiative.

**Order of consultation** for any feature work: (1) the plan
(`implementation.md` + `plan.db` decisions) for what is in scope and sequenced
now; (2) TABLED.md to confirm the feature is not set aside; (3) FEATURES.md
section 4 for the feature's old shape and location, treating superseded sections
as history only.
