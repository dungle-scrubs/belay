# Cwd-path advisory lock - contract & placement (M1)

The dedicated cwd-path advisory lock that hardens managed worktrees against two **different** Trevor
sessions mutating the same real directory. Source module: `apps/agent-host/src/cwd-lock.ts`
(pure core, unit-tested in `cwd-lock.test.ts`). This doc is the M1 contract; M2 wires it into the host.

## Why it exists (beyond the existing per-session lock)

| Lock | Resource it owns | Keyed by | Lives in | Held for |
|---|---|---|---|---|
| Per-session launcher lock (D-085) | a session's spawn turn | `sessionId` | launcher (`trevor-cli`) | the launch window only |
| **Cwd advisory lock (this plan)** | a real working **directory** | normalized **realpath** | host (`agent-host`) | the leader's lifetime |

The per-session lock keeps two concurrent `trevor` launches of the **same** session from both spawning.
It does **not** protect the *path*: two **different** session identities can resolve to the same real
directory (a symlinked path, a managed worktree reached via `/cd` under a fresh session, two repos
aliased to one dir) and both mutate it. The cwd lock closes that gap. It is **advisory**: it governs
Trevor-owned mutating host ownership, not arbitrary external processes.

## Normalized identity

- The lock keys on `realpath(cwd)` - the resource, independent of how the path was reached. Two aliases
  of one directory map to one lock file; nothing branches on whether the path is a worktree, so a
  managed-worktree cwd and a plain project cwd obey the **same** path-ownership rule.
- Lock file: `<TREVOR_STATE_HOME>/cwd-locks/<slug>-<shortHash(realpath)>.lock`. The slug is human-scannable;
  the `shortHash` (the browser-safe FNV-1a from `@trevor/session`) disambiguates like-named dirs.

## Placement (where it lives)

- Directory: the state home, **not** the config home. The plan text loosely said `TREVOR_HOME`, but
  locks are machine-local runtime state, so they live under `TREVOR_STATE_HOME` next to the existing
  per-session `locks/`. Registered as inventory entry **`cwd-locks`** in
  `packages/session/src/node-paths.ts` `STORAGE_INVENTORY`; the module resolves it via
  `storagePathByName("cwd-locks")` (no re-spelled home-relative literal - the drift guard stays green).
- Ownership boundary: path ownership is the **host's** concern (the host owns the cwd it works in);
  per-session/process ownership stays the launcher's. The two locks do not share code - kept separate
  on purpose (risk register: "Keep cwd lock as path ownership, per-session lock as process ownership").
- Lock policy is independent of worktree-registry persistence: `cwd-lock.ts` imports nothing from
  `worktrees/` and the registry imports nothing from it (M1 REFACTOR).

## Owner metadata & "self"

Lock record: `{ cwd (realpath), sessionId, hostId, pid, acquiredAt, heartbeatAt }`.

- **Same logical owner = same `sessionId`.** A different host/pid of the same session (leader<->standby
  failover, a host restart) re-takes the lock rather than conflicting - same-session churn is invisible.
- **Same physical owner = same `hostId` + `pid`.** Only this exact process may `refresh` or `release`
  (never steals a successor's lock).
- **Conflict = a different, live `sessionId`** owning the same realpath. This is the hazard; the caller
  surfaces it (it is not stolen).

## Stale policy (crash/restart safe)

A lock is stale (and reclaimable on the next acquire) when:

1. the owner `pid` is not a live process (crash/exit - the primary gate), **or**
2. the `pid` still appears alive but the heartbeat is older than `CWD_LOCK_STALE_MS` (default 5 min) -
   the belt to pid-liveness, covering pid reuse and a wedged/abandoned owner.

A fresh, live, heartbeating owner is never stolen. Reclamation happens only on `acquireCwdLock`;
`inspectCwdLock` is read-only (no auto-repair).

## Acquisition / release points (specified here, wired in M2)

| Point | Operation | Notes |
|---|---|---|
| **Host becomes leader** (`onBecomeLeader`) | `acquireCwdLock(cwd, {sessionId, hostId, pid})` | The leader is the single mutating owner of the cwd. On `conflict`, surface contention (typed `CwdLockConflict`), do not assume ownership. A **standby** never acquires (passive observer) - failover within a session is unaffected. |
| **Heartbeat timer** (while leader) | `refreshCwdLock` | Moves `heartbeatAt` forward so a crashed leader's lock ages into stale. `not-owner`/`missing` means a takeover happened - re-acquire or surface. |
| **Worktree / workspace switch** | `acquireCwdLock` for the **target** cwd before switching | The explicit, user-initiated mutating workspace op. A different live session owning the target blocks the switch with `CwdLockConflict` "before workspace mutation". |
| **Graceful stop / process exit** (`performGracefulStop`, SIGINT/SIGTERM) | `releaseCwdLock` | Frees the path for the next owner. Same-session takeover also overwrites, so a missed release is self-healing; a crash leaves a stale lock that the next acquire reclaims. |

## Diagnostics (observability)

- `inspectCwdLock(cwd)` returns `{ cwd, path, file, owner: {…, heartbeatAgeMs, alive}, stale }` - the
  read model `/doctor` renders (owner, cwd, session, pid, heartbeat age, stale classification).
- `CwdLockConflict.message` / `cwdLockConflictMessage` give the operator-facing explanation **plus** the
  safe recommended action (inspect with `/doctor`; only hand-clear the lock file when certain no host is
  using the directory). No surface repairs or mutates a lock by default.

## Done for M1

- [x] Contract + exhaustive unit tests (identity normalization, owner metadata, same-session re-take,
  conflict, stale-by-pid, stale-by-heartbeat, malformed file, refresh, release, inspect).
- [x] Placement decided and registered (`cwd-locks` inventory entry under the state home).
- [x] `CwdLockConflict` typed error + reusable message helpers.
- [x] Lock policy kept separate from worktree-registry persistence.
