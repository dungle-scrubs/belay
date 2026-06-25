import assert from "node:assert/strict";
import { test } from "vitest";
import { Lease, type LeaseRole } from "./lease";

/**
 * The lease election state machine, driven with INJECTED time (tick/observe take the clock
 * as an argument), so leadership, deferral, tie-break, and ttl takeover are tested
 * deterministically with no real waiting. Ported from scripts/verify-lease-unit.ts.
 */

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

test("a lone host probes, then claims leadership after probeMs of silence", () => {
  const a = makeLease("a");
  a.lease.start(0);
  a.lease.tick(50);
  assert.equal(a.lease.getRole(), "probing");
  a.lease.tick(150);
  assert.equal(a.lease.getRole(), "leader");
  assert.ok(a.beats.length >= 1);
});

test("a later host hears the leader's beat, defers, and pings as standby", () => {
  const b = makeLease("b");
  b.lease.start(1000);
  b.lease.observe("a", "beat", 1050);
  assert.equal(b.lease.getRole(), "standby");
  b.lease.observe("a", "beat", 1150);
  b.lease.tick(1200);
  assert.equal(b.lease.getRole(), "standby");
  assert.ok(b.hellos.length >= 1, `hellos=${b.hellos.length}`);
});

test("simultaneous claim: the smaller instanceId wins, the larger steps down", () => {
  const a = makeLease("a");
  const z = makeLease("z");
  a.lease.start(0);
  z.lease.start(0);
  a.lease.tick(150);
  z.lease.tick(150);
  assert.ok(a.lease.getRole() === "leader" && z.lease.getRole() === "leader");
  z.lease.observe("a", "beat", 200); // z sees a (a<z) within settle -> step down
  a.lease.observe("z", "beat", 200); // a sees z (z>a) -> stays
  assert.equal(z.lease.getRole(), "standby");
  assert.equal(a.lease.getRole(), "leader");
});

test("leader death: a standby stops hearing beats and takes over after ttl", () => {
  const b = makeLease("b");
  b.lease.start(1000);
  b.lease.observe("a", "beat", 1050);
  b.lease.observe("a", "beat", 1200);
  b.lease.tick(1300);
  assert.equal(b.lease.getRole(), "standby");
  b.lease.tick(1500); // ttlMs=300 since last beat (1200) -> re-probe
  assert.equal(b.lease.getRole(), "probing");
  b.lease.tick(1620); // probeMs=100 -> leader
  assert.equal(b.lease.getRole(), "leader");
});

test("a hello (not a beat) never causes deferral", () => {
  const a = makeLease("a");
  a.lease.start(0);
  a.lease.observe("b", "hello", 30);
  assert.equal(a.lease.getRole(), "probing");
  a.lease.tick(150);
  assert.equal(a.lease.getRole(), "leader");
});

test("a lone leader writes one claim beat and no ongoing pings", () => {
  const a = makeLease("a");
  a.lease.start(0);
  a.lease.tick(150);
  a.lease.tick(300);
  a.lease.tick(600);
  a.lease.tick(1000);
  assert.equal(a.beats.length, 1, `beats=${a.beats.length}`);
  assert.equal(a.hellos.length, 0, `hellos=${a.hellos.length}`);
});

test("the leader beats promptly when another host appears (no split-brain)", () => {
  const a = makeLease("a");
  a.lease.start(0);
  a.lease.tick(150);
  const base = a.beats.length;
  a.lease.observe("b", "hello", 200);
  assert.ok(a.beats.length > base, `beats=${a.beats.length}`);
});
