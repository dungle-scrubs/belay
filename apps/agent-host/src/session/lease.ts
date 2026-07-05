/**
 * Single-authority election for trevor hosts sharing one Tether session.
 *
 * Every host connects with a distinct participant id (so Tether lets them all
 * coexist and observe the log), but only ONE - the leader - answers turns and
 * touches the filesystem. Leadership is negotiated over the durable event log
 * with two payload-tagged signals (instanceId identifies the sender):
 *   - `host.hello`  presence ping: emitted on go-live and, by a STANDBY, every
 *                   heartbeat so the leader knows it is still being watched.
 *   - `host.beat`   leadership signal: emitted by the LEADER while it has seen
 *                   another host recently (contention). A lone host stays
 *                   silent, so the steady single-host case writes nothing.
 *
 * Election (incumbent-wins, with a tiebreak for simultaneous starts):
 *   - On start a host PROBES: a live beat means a leader exists -> defer
 *     (standby); after probeMs of silence it claims leadership. A leader beats
 *     promptly when it sees any other host, so a newcomer defers fast.
 *   - A standby that stops hearing the leader for ttlMs takes over.
 *   - If two hosts claim at once they both beat; whoever sees a beat from a
 *     smaller instanceId within settleMs steps down. Smallest id wins.
 *
 * Pure and time-injectable: the host drives it via tick()/observe() with
 * Date.now(); no internal clock, so the state machine is unit-testable.
 *
 * Responsible for: single-leader election among hosts sharing one session (probe/beat/takeover).
 * Not for: cwd resource ownership across sessions - session/cwd-lock.ts guards that.
 */

import { debug } from "@host/transport/log";
import type { HostRole } from "@trevor/session";

/** Lease roles: the wire-visible `HostRole` (leader/standby) plus the private "probing"
 *  start state the lease occupies before it has claimed or deferred. */
export type LeaseRole = "probing" | HostRole;
export type HostSignal = "hello" | "beat";

export interface LeaseCallbacks {
  /** Publish a host.beat (leadership signal) for this instance. */
  readonly emitBeat: () => void;
  /** Publish a host.hello (presence ping) for this instance. */
  readonly emitHello: () => void;
  /** Fired on every role transition (announce + leader-side catch-up). */
  readonly onRoleChange: (role: LeaseRole) => void;
}

export interface LeaseOptions {
  readonly heartbeatMs?: number;
  readonly probeMs?: number;
  readonly ttlMs?: number;
  readonly settleMs?: number;
}

const DEFAULTS = { heartbeatMs: 5000, probeMs: 4000, ttlMs: 16000, settleMs: 10000 };

export class Lease {
  readonly instanceId: string;
  private readonly cb: LeaseCallbacks;
  private readonly heartbeatMs: number;
  private readonly probeMs: number;
  private readonly ttlMs: number;
  private readonly settleMs: number;
  private readonly promptGap: number;

  private role: LeaseRole = "probing";
  private started = false;
  private probeStart = 0;
  private claimedAt = 0;
  private lastEmit = 0;
  /** Local time we last saw any OTHER host's hello/beat (liveness + contention). */
  private lastOther = Number.NEGATIVE_INFINITY;

  constructor(instanceId: string, cb: LeaseCallbacks, options: LeaseOptions = {}) {
    this.instanceId = instanceId;
    this.cb = cb;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULTS.heartbeatMs;
    this.probeMs = options.probeMs ?? DEFAULTS.probeMs;
    this.ttlMs = options.ttlMs ?? DEFAULTS.ttlMs;
    this.settleMs = options.settleMs ?? DEFAULTS.settleMs;
    this.promptGap = Math.floor(this.heartbeatMs / 2);
  }

  getRole(): LeaseRole {
    return this.role;
  }

  isLeader(): boolean {
    return this.role === "leader";
  }

  /**
   * A snapshot of the election internals for /doctor: the role plus the timing deltas
   * that actually decide leadership (how long since any other host was seen, time since
   * our last emit, and - when leader - whether we currently consider ourselves contended).
   */
  debugInfo(now: number): Record<string, unknown> {
    return {
      role: this.role,
      started: this.started,
      msSinceOther: this.lastOther === Number.NEGATIVE_INFINITY ? null : now - this.lastOther,
      msSinceEmit: this.started ? now - this.lastEmit : null,
      contended: this.role === "leader" ? now - this.lastOther < this.ttlMs : null,
    };
  }

  /** Begin probing. Idempotent across reconnects - only the first call starts the clock. */
  start(now: number): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.role = "probing";
    this.probeStart = now;
  }

  /** Feed a live (post-replay) host signal from another instance. */
  observe(senderInstanceId: string, signal: HostSignal, now: number): void {
    if (!this.started || senderInstanceId === this.instanceId) {
      return;
    }
    this.lastOther = now;
    if (this.role === "leader") {
      // Simultaneous-claim tiebreak: a competing beat from a smaller id wins.
      if (
        signal === "beat" &&
        now - this.claimedAt < this.settleMs &&
        senderInstanceId < this.instanceId
      ) {
        debug("lease", "stepping down for smaller id", { other: senderInstanceId.slice(0, 8) });
        this.setRole("standby", now);
        return;
      }
      // Otherwise announce leadership promptly so the newcomer defers fast.
      if (now - this.lastEmit >= this.promptGap) {
        this.lastEmit = now;
        this.cb.emitBeat();
      }
      return;
    }
    if (this.role === "probing" && signal === "beat") {
      this.setRole("standby", now); // an established leader is already beating - defer
    }
  }

  /** Periodic evaluation; drives probe->leader, standby pings + takeover, and beats. */
  tick(now: number): void {
    if (!this.started) {
      return;
    }
    if (this.role === "probing") {
      if (now - this.probeStart >= this.probeMs) {
        this.setRole("leader", now);
      }
      return;
    }
    if (this.role === "leader") {
      const contended = now - this.lastOther < this.ttlMs;
      if (contended && now - this.lastEmit >= this.heartbeatMs) {
        this.lastEmit = now;
        this.cb.emitBeat();
      }
      return;
    }
    // standby: keep the leader aware we are watching, and take over if it goes quiet
    if (now - this.lastEmit >= this.heartbeatMs) {
      this.lastEmit = now;
      this.cb.emitHello();
    }
    if (now - this.lastOther >= this.ttlMs) {
      debug("lease", "leader went quiet, re-probing", { quietMs: now - this.lastOther });
      this.role = "probing";
      this.probeStart = now;
    }
  }

  private setRole(role: LeaseRole, now: number): void {
    if (role === this.role) {
      return;
    }
    this.role = role;
    this.lastEmit = now;
    if (role === "leader") {
      this.claimedAt = now;
      this.cb.emitBeat(); // claim immediately so a co-probing host can defer fast
    }
    this.cb.onRoleChange(role);
  }
}
