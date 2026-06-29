# Two-host worktree contention - operator runbook (M4)

How to reproduce, observe, and clean up cwd-lock contention between two Trevor hosts that target the
same working directory. The deterministic proof is the CI smoke (`e2e/cwd-lock-smoke.test.ts`); this
runbook covers the FULL two-host boot, which is timing-flaky (lease election) and therefore manual
rather than a CI lane (D-003).

## What the cwd advisory lock guards

A host claims the cwd lock for its workspace directory when it becomes the session **leader** (the
single mutating owner). The lock is keyed on the directory's **realpath**, so two *different* sessions
that resolve to the same real directory contend even though their per-session locks differ. A standby
host never holds it. Lock files live under `TREVOR_STATE_HOME/cwd-locks/<slug>-<hash>.lock`.

## Reproduce two-host contention manually

The fastest reliable path is the gated smoke harness's own mechanism. To drive the FULL hosts:

1. Pick an isolated state home and a throwaway repo so nothing touches real sessions:
   ```sh
   export TREVOR_STATE_HOME=$(mktemp -d) TREVOR_HOME=$TREVOR_STATE_HOME
   REPO=$(mktemp -d); git -C "$REPO" init -q && git -C "$REPO" commit -q --allow-empty -m base
   WT="$TREVOR_STATE_HOME/.worktrees/shared"
   git -C "$REPO" worktree add -q -b feat/shared "$WT"
   ```
2. Boot a session-store the hosts can reach (e.g. `pnpm --filter @trevor/session-store start`), and
   note its URL as `SESSION_STORE_URL`.
3. Launch **two** hosts, distinct `SESSION_ID`s, both with `cwd = $WT` and the same state home. Elect
   fast so you don't wait the default probe window:
   ```sh
   cd "$WT"
   SESSION_ID=host-a SESSION_STORE_URL=$URL TREVOR_WORKSPACE=$WT \
     LEASE_PROBE_MS=300 LEASE_TTL_MS=2000 node --import tsx <repo>/apps/agent-host/src/main.ts &
   SESSION_ID=host-b SESSION_STORE_URL=$URL TREVOR_WORKSPACE=$WT \
     LEASE_PROBE_MS=300 LEASE_TTL_MS=2000 node --import tsx <repo>/apps/agent-host/src/main.ts &
   ```
4. After ~1-2 s, exactly one host owns the lock; the other logs `cwd lock contended by another
   session`. Confirm:
   ```sh
   cat "$TREVOR_STATE_HOME"/cwd-locks/*.lock   # one record, one owning sessionId/pid
   ```

A managed-worktree **switch** into a directory a different live session already owns is refused before
any host is spawned, with `Cannot switch - cwd <path> is already owned by host <id> (session <id>,
pid <n>, ...)`.

## Expected `/doctor` output for cwd-lock / worktree ownership

The cwd-lock state is in the **Workspace** area, both as a structured fact and in `/doctor text`:

| State | Fact line | Finding |
|---|---|---|
| held by this session | `cwd lock: held by this session` | none (ok) |
| unlocked | `cwd lock: unlocked` | none (ok) |
| contended (different live session) | `cwd lock: contended - host <id> (session <id>, pid <n>, alive, ...)` | **warn** "Cwd lock contended" + next action |
| stale (dead/abandoned owner) | `cwd lock: stale - ... (reclaimed on next acquire)` | **warn** "Stale cwd lock" |

The contended/stale findings carry a **non-destructive** next action: inspect the owning host, and only
force-clear the lock file when you are certain no host is using the directory. `/doctor` never repairs
or deletes a lock.

## Stale / crash behavior

- A host that **crashes** (SIGKILL) leaves its lock behind. The next leader of the same path reclaims
  it once it is stale: the owner pid is dead, or its heartbeat is older than the staleness window
  (`CWD_LOCK_STALE_MS`, 5 min). A live, heartbeating owner is never stolen.
- A host that **stops gracefully** (SIGTERM / `trevor stop`) releases the lock immediately.

## Regression checklist - cleanup after a failed smoke / manual run

Run these if a smoke run or manual two-host test is interrupted:

1. **Stray hosts** - the manual two-host boot can leave hosts running:
   ```sh
   ps -Ao pid,ppid,command | grep '[a]gent-host/src/main.ts'   # watch for ppid 1 (orphaned)
   pkill -9 -f 'agent-host/src/main.ts'
   ```
2. **Temp dirs** - remove the throwaway state home and repo from the reproduction
   (`$TREVOR_STATE_HOME`, `$REPO`). The deterministic smoke does this automatically in `afterAll`.
3. **Stale locks** - if you reused a real state home, a leftover lock is harmless (it is reclaimed on
   the next acquire once stale) but can be cleared manually: confirm no host is using the directory,
   then delete the matching file under `TREVOR_STATE_HOME/cwd-locks/`.
4. **Git worktrees** - prune any leftover temp worktrees: `git -C "$REPO" worktree prune`.

The CI smoke (`e2e/cwd-lock-smoke.test.ts`) needs none of this: it group-kills every actor in
`afterEach`, prunes worktrees, and removes its temp state home + repo in `afterAll`.
