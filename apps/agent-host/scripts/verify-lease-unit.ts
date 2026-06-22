// Deterministic unit test for the lease election state machine, driven with
// injected time. Run: pnpm exec tsx scripts/verify-lease-unit.ts
import { Lease, type LeaseRole } from "../src/lease";

const OPTS = { heartbeatMs: 100, probeMs: 100, ttlMs: 300, settleMs: 250 };

function makeLease(id: string) {
  const beats: number[] = [];
  const hellos: number[] = [];
  const roles: LeaseRole[] = [];
  const lease = new Lease(
    id,
    {
      emitBeat: () => beats.push(1),
      emitHello: () => hellos.push(1),
      onRoleChange: (r) => roles.push(r),
    },
    OPTS,
  );
  return { lease, beats, hellos, roles };
}

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (!ok) {
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
    failures += 1;
  }
};

// 1. Lone host probes, then claims leadership after probeMs of silence.
{
  const a = makeLease("a");
  a.lease.start(0);
  a.lease.tick(50);
  check("lone: still probing before probeMs", a.lease.getRole() === "probing", a.lease.getRole());
  a.lease.tick(150);
  check("lone: leader after probeMs", a.lease.getRole() === "leader", a.lease.getRole());
  check("lone: emitted a claim beat", a.beats.length >= 1);
}

// 2. A later host hears the leader's beat, defers, and then pings as standby.
{
  const b = makeLease("b");
  b.lease.start(1000);
  b.lease.observe("a", "beat", 1050);
  check("defer: standby on beat", b.lease.getRole() === "standby", b.lease.getRole());
  b.lease.observe("a", "beat", 1150);
  b.lease.tick(1200);
  check("defer: stays standby while beats continue", b.lease.getRole() === "standby");
  check("defer: standby pings to stay visible", b.hellos.length >= 1, `hellos=${b.hellos.length}`);
}

// 3. Simultaneous claim: the smaller instanceId wins, the larger steps down.
{
  const a = makeLease("a");
  const z = makeLease("z");
  a.lease.start(0);
  z.lease.start(0);
  a.lease.tick(150);
  z.lease.tick(150);
  check("tie: both claim", a.lease.getRole() === "leader" && z.lease.getRole() === "leader");
  z.lease.observe("a", "beat", 200); // z sees a (a<z) within settle -> step down
  a.lease.observe("z", "beat", 200); // a sees z (z>a) -> stays
  check("tie: larger id (z) yields", z.lease.getRole() === "standby", z.lease.getRole());
  check("tie: smaller id (a) leads", a.lease.getRole() === "leader", a.lease.getRole());
}

// 4. Leader death: standby stops hearing beats and takes over.
{
  const b = makeLease("b");
  b.lease.start(1000);
  b.lease.observe("a", "beat", 1050);
  b.lease.observe("a", "beat", 1200);
  b.lease.tick(1300);
  check("takeover: standby while leader alive", b.lease.getRole() === "standby");
  b.lease.tick(1500); // ttlMs=300 since last beat (1200) -> re-probe
  check("takeover: re-probing after ttl", b.lease.getRole() === "probing", b.lease.getRole());
  b.lease.tick(1620); // probeMs=100 -> leader
  check("takeover: became leader", b.lease.getRole() === "leader", b.lease.getRole());
}

// 5. A hello (not a beat) never causes deferral.
{
  const a = makeLease("a");
  a.lease.start(0);
  a.lease.observe("b", "hello", 30);
  check("hello: still probing", a.lease.getRole() === "probing", a.lease.getRole());
  a.lease.tick(150);
  check("hello: becomes leader anyway", a.lease.getRole() === "leader");
}

// 6. A lone leader writes no ongoing beats or pings (single-host log stays quiet).
{
  const a = makeLease("a");
  a.lease.start(0);
  a.lease.tick(150);
  a.lease.tick(300);
  a.lease.tick(600);
  a.lease.tick(1000);
  check("lone: one claim beat only", a.beats.length === 1, `beats=${a.beats.length}`);
  check("lone: no pings", a.hellos.length === 0, `hellos=${a.hellos.length}`);
}

// 7. The leader beats promptly when another host appears (fast deferral, no split-brain).
{
  const a = makeLease("a");
  a.lease.start(0);
  a.lease.tick(150);
  const base = a.beats.length;
  a.lease.observe("b", "hello", 200);
  check(
    "contention: leader beats promptly on contact",
    a.beats.length > base,
    `beats=${a.beats.length}`,
  );
}

if (failures === 0) {
  console.log("LEASE-UNIT PASS (7 scenarios)");
} else {
  console.error(`LEASE-UNIT FAIL (${failures})`);
  process.exit(1);
}
