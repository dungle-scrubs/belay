import { ADMISSION_HEARTBEAT_MS } from "@host/admission/store";
import type { CompactionCommandsApi } from "@host/agent/compaction-commands";
import type { TurnMachine } from "@host/agent/turn-machine";
import type { TurnScheduler } from "@host/agent/turn-scheduler";
import type { InternetMonitor } from "@host/connectivity/probe";
import { DEFAULT_PROVIDER, type ProviderRegistry } from "@host/providers/index";
import type { HostResidency } from "@host/residency/host";
import {
  CWD_LOCK_HEARTBEAT_MS,
  type CwdLockCaps,
  type CwdLockOwner,
  refreshCwdLock,
} from "@host/session/cwd-lock";
import type { Lease } from "@host/session/lease";
import { log, warn } from "@host/transport/log";
import type { EmitEvent } from "@host/transport/services";
import { events, pendingFollowUps, type SessionEvent } from "@trevor/session";
import { Cause, Effect } from "effect";
import { envNumber } from "./env";
import { WORKSPACE_ROOT } from "./paths";

/**
 * Go-live + leadership transitions, extracted from main.ts (plan 22.3): main.ts constructs
 * {@link makeLeadership} once over its lease/scheduler and reap/resume/announce seams; connect()'s
 * replay-complete callback calls goLive, and the Lease's onRoleChange closure calls onBecomeLeader
 * - both resolved at runtime, so wiring order stays TDZ-safe.
 *
 * Responsible for: the once-only lease/heartbeat start + reconnect reconcile on go-live, and the
 * leader-transition reconcile (cwd lock claim, orphan reap, dangling-/compact result, prompt
 * catch-up, local pre-warm).
 * Not for: the lease election itself (session/lease.ts), what a reap/resume does
 * (agent/run-lifecycle.ts + agent/control-prompts.ts), or the host.online snapshot
 * (transport/presence.ts).
 */

/** Lease timings are overridable via env so tests can run fast. */
export function leaseOptions() {
  return {
    heartbeatMs: envNumber("LEASE_HEARTBEAT_MS"),
    probeMs: envNumber("LEASE_PROBE_MS"),
    ttlMs: envNumber("LEASE_TTL_MS"),
    settleMs: envNumber("LEASE_SETTLE_MS"),
  };
}

/** The live main.ts state and seams the leadership transitions run through. */
export interface LeadershipDeps {
  /** This host instance's id, stamped on the hello it emits on go-live. */
  readonly instanceId: string;
  /** Publish one host-authored event to the durable log (main.ts's emit). */
  readonly emit: EmitEvent;
  /** The lease: started once on go-live, ticked on a timer, and read for leader gating. */
  readonly lease: Pick<Lease, "isLeader" | "start" | "tick">;
  /** The turn scheduler: the leader reconcile drops stale prompts + catches up pending ones. */
  readonly scheduler: Pick<TurnScheduler, "clearPending" | "noteTurn" | "isBusy">;
  /** This host's producerId, so catch-up excludes the host's own user.message echoes. */
  readonly selfProducerId: string;
  /** The durable events seen this connection (main.ts's conversationLog): the leader re-derives the
   *  whole follow-up backlog from them (plan 47), so a disconnected client's queue still drains. */
  conversationEvents(): readonly SessionEvent[];
  /** The turn machine: dangling in-flight runs decide reap-vs-resume on taking leadership. */
  readonly turnMachine: Pick<TurnMachine, "hasInFlight">;
  /** The internet monitor (D-060): the new leader kicks a fresh probe + re-announce. */
  readonly internet: Pick<InternetMonitor, "refresh">;
  /** The registered providers: the local default is pre-warmed off the leader transition. */
  readonly providers: ProviderRegistry;
  /** The host's local-model residency: its claim heartbeat runs on the go-live timer. */
  readonly residency: Pick<HostResidency, "heartbeat">;
  /** Whether replay has completed and the host is answering (main.ts's mutable `live` flag). */
  live(): boolean;
  /** Read the dangling-/compact marker (main.ts's mutable `compactPending`). */
  getCompactPending(): boolean;
  /** Clear/set the dangling-/compact marker. */
  setCompactPending(value: boolean): void;
  /** The in-flight MANUAL /compact fold, or null (agent/compaction-commands' getter). */
  manualCompactFiber: CompactionCommandsApi["manualCompactFiber"];
  /** Claim the cwd advisory lock as the new mutating owner (main.ts's acquireWorkspaceCwdLock). */
  acquireWorkspaceCwdLock(): void;
  /** The cwd lock's owner identity (main.ts's cwdLockOwner). */
  cwdLockOwner(): CwdLockOwner;
  /** The node-backed cwd lock capabilities (main.ts's cwdLockCaps). */
  readonly cwdLockCaps: CwdLockCaps;
  /** Emit the host.online snapshot (transport/presence, wired through main.ts). */
  announceOnline(): void;
  /** Close runs a previous leader left dangling (agent/run-lifecycle, wired through main.ts). */
  reapOrphans(): void;
  /** Close background subagents a previous leader left dangling (plan 52, agent/run-lifecycle). Shares
   *  the same two takeover triggers as reapOrphans - the turn and subagent reaps fire together. */
  reapOrphanSubagents(): void;
  /** Close ask_user questions a previous leader left dangling (agent/run-lifecycle): the in-memory
   *  waiter died with the asking host, so the browser's question panel is otherwise permanently
   *  un-submittable (AQ001 no-ops) with the composer unmounted behind it. Fires at the same two
   *  takeover triggers as reapOrphanSubagents. */
  reapOrphanQuestions(): void;
  /** Auto-resume an un-continued trailing interrupt (agent/control-prompts, wired through main.ts). */
  maybeAutoResume(): void;
}

/** Builds the go-live + leader-transition handlers over the host's live seams; main.ts wires it once. */
export function makeLeadership(deps: LeadershipDeps) {
  const {
    instanceId: INSTANCE_ID,
    emit,
    lease,
    scheduler,
    selfProducerId,
    conversationEvents,
    turnMachine,
    internet,
    providers,
    residency,
    live,
    getCompactPending,
    setCompactPending,
    manualCompactFiber,
    acquireWorkspaceCwdLock,
    cwdLockOwner,
    cwdLockCaps,
    announceOnline,
    reapOrphans,
    reapOrphanSubagents,
    reapOrphanQuestions,
    maybeAutoResume,
  } = deps;

  let leaseRunning = false;

  /** On becoming leader: answer any pending prompt, else pre-warm the local model. */
  function onBecomeLeader(): void {
    // Claim the cwd advisory lock now that we are the mutating owner of this directory (plan 01).
    acquireWorkspaceCwdLock();
    // The leader owns the internet probe (D-060): kick off a fresh check + re-announce so the advisory
    // reflects this host's reachability. Fire-and-forget - a turn never waits on it.
    internet
      .refresh()
      .then(announceOnline)
      .catch(() => {});
    // Close background subagents a previous leader left dangling (plan 52). Unlike a turn, a background
    // child OUTLIVES its spawning turn, so its orphan can exist with NO in-flight run - hence this fires
    // outside the hasInFlight branch below, keyed by the child's log link rather than the turn set.
    reapOrphanSubagents();
    // Close ask_user questions a previous leader left dangling. Like the subagent reap this fires
    // outside the hasInFlight branch: a question can outlive its run's reap (an earlier takeover closed
    // the run as interrupted but pre-fix left the question pending), so it is keyed by the question's
    // own requested/resolved log pair, not the turn set.
    reapOrphanQuestions();
    if (turnMachine.hasInFlight) {
      // A previous leader left turns dangling (crashed / hot-reloaded mid-turn). Close them so every
      // client stops reading them as active (unfreezes the send queue, makes ESC meaningful), and drop
      // the stale pending prompt. Each reap's interrupted completion echoes back to the completion handler,
      // which auto-resumes it from the transcript (bounded) - so the work continues instead of stranding
      // the user mid-turn, while a user ESC (cancelled, not interrupted) still stays put.
      reapOrphans();
      scheduler.clearPending();
    } else if (live()) {
      // No dangling run, but the trailing turn may be an un-continued interrupt a prior host never
      // resumed (e.g. the browser recovered the orphan, then this host took leadership while already
      // live - the path goLive's post-replay reconcile doesn't re-run). Pick it up.
      maybeAutoResume();
    }
    // A /compact whose fold a previous leader was interrupted mid-run (restart/crash) left its command
    // with no result - a dangling "/compact" that looks broken. Give it one. `!manualCompactFiber`
    // guards the (rare) leadership-flap-mid-fold case where this host is the one actually running it.
    if (getCompactPending() && !manualCompactFiber()) {
      setCompactPending(false);
      emit(
        events.commandResult({
          command: "/compact",
          text: "Compaction interrupted — the host restarted. Run /compact again.",
          ok: false,
        }),
      ).catch(() => {});
    }
    // Re-derive the whole durable follow-up backlog from the log (plan 47 M2): every unanswered,
    // not-superseded prompt in submit order, not just the latest. `noteTurn`-ing them in order runs the
    // first now and defers the rest behind it (the scheduler's FIFO), so a disconnected client's queue
    // drains all-in-order and a host restart mid-backlog resumes the remaining prompts. Guarded on idle
    // so a leadership flap mid-turn never re-queues the running prompt.
    if (!scheduler.isBusy()) {
      const pending = pendingFollowUps(conversationEvents(), selfProducerId);
      if (pending.length > 0) {
        log("host", "catch-up", { pending: pending.length });
        for (const prompt of pending) {
          scheduler.noteTurn(prompt);
        }
        return;
      }
    }
    const local = providers[DEFAULT_PROVIDER];
    if (!local) {
      return;
    }
    // Pre-warm the local model off the leader transition (best-effort: log and move on).
    Effect.runFork(
      Effect.gen(function* () {
        const { warm } = yield* local.readiness();
        if (!warm) {
          yield* local.warm();
        }
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.sync(() => warn("host", "warm failed", { cause: Cause.pretty(cause) })),
        ),
      ),
    );
  }

  /** On go-live: start the lease (once), announce presence, and report online. */
  function goLive(): void {
    log("host", "replay complete; live");
    if (!leaseRunning) {
      leaseRunning = true;
      lease.start(Date.now());
      setInterval(() => lease.tick(Date.now()), 500);
      // Keep the cwd advisory lock's heartbeat fresh while we lead, so a crashed leader's lock ages into
      // stale and is reclaimable (plan 01). Leader-gated, cheap, best-effort.
      setInterval(() => {
        if (lease.isLeader()) {
          try {
            refreshCwdLock(WORKSPACE_ROOT, cwdLockOwner(), cwdLockCaps);
          } catch {
            // best-effort heartbeat
          }
        }
      }, CWD_LOCK_HEARTBEAT_MS);
      // Keep this instance's local-model residency claim fresh so it doesn't age into stale + get
      // reclaimed while we still hold the model (plan 11.1). A no-op when no local model is claimed.
      setInterval(() => {
        void residency.heartbeat();
      }, ADMISSION_HEARTBEAT_MS);
    }
    emit(events.hostHello({ instanceId: INSTANCE_ID })).catch(() => {});
    announceOnline();
    // Reconnect reconcile: a turn that ended while the store was unreachable (a socket/store outage,
    // e.g. a watch-lane restart mid-turn) had its terminal completion lost, leaving it
    // started-with-no-completion in the log - a forever-"Working" phantom. Now that the stream is back,
    // close every such orphan. A genuinely live turn (runningRunId) is excluded, so this never cuts a
    // real turn short. Leader-only: only the owner closes runs. (Cold leadership also reaps via
    // onBecomeLeader; this adds the reconnect-as-existing-leader path that case misses.)
    if (lease.isLeader()) {
      reapOrphans();
      // Same reconnect reconcile for background subagents a dead leader left dangling (plan 52): the two
      // reaps share this one takeover trigger, so a failover closes both stuck turns and stuck children.
      reapOrphanSubagents();
      // And for dangling ask_user questions: a restart mid-question dropped the in-memory waiter, so
      // resolve the question as cancelled here or the browser's panel stays un-submittable forever.
      reapOrphanQuestions();
      // After reaping, auto-resume an un-continued trailing interrupt that is already settled in the log
      // (the browser recovered the orphan while no host was up - tonight's nimoy/lucid case). A run this
      // reap just closed is still mid-echo, so it is picked up by the completion handler, not here.
      maybeAutoResume();
    }
  }

  return { goLive, onBecomeLeader };
}
