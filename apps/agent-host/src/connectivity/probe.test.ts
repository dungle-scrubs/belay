import assert from "node:assert/strict";
import type { InternetSnapshot } from "@belay/session";
import { test } from "vitest";
import { InternetMonitor, type ProbeIo, type ProbeTargets, probeInternet } from "./probe";

/**
 * D-060 M1/M2: the host internet probe + monitor. Online requires DNS + HTTPS to both pass; any
 * failure (LAN-up/WAN-down, captive portal, reset) reads offline with a sanitized reason; a disabled
 * probe is unknown. The monitor caches, dedupes, exposes `checking`, and emits each transition.
 */

const TARGETS: ProbeTargets = {
  dnsHost: "example-dns.invalid",
  httpsUrl: "https://example.invalid/trace",
  enabled: true,
};

function io(over: Partial<ProbeIo>): ProbeIo {
  return {
    resolveDns: () => Promise.resolve(),
    httpsReachable: () => Promise.resolve(true),
    now: () => "2026-06-26T12:00:00.000Z",
    ...over,
  };
}

test("probeInternet reports online when DNS and HTTPS both succeed", async () => {
  const snap = await probeInternet(TARGETS, io({}));
  assert.equal(snap.status, "online");
  assert.equal(snap.error, null);
  assert.equal(snap.targetClass, "dns+https");
  assert.equal(snap.checkedAt, "2026-06-26T12:00:00.000Z");
});

test("probeInternet reports offline when the HTTPS probe throws (WAN down)", async () => {
  const snap = await probeInternet(
    TARGETS,
    io({ httpsReachable: () => Promise.reject(new Error("ECONNRESET https://secret")) }),
  );
  assert.equal(snap.status, "offline");
  assert.ok(snap.error?.includes("HTTPS probe failed"));
  assert.ok(!snap.error?.includes("secret"), "the sanitized error never leaks the endpoint");
});

test("probeInternet reports offline for a captive-portal-like error status", async () => {
  const snap = await probeInternet(TARGETS, io({ httpsReachable: () => Promise.resolve(false) }));
  assert.equal(snap.status, "offline", "an error status (not a clean 2xx) is offline");
});

test("probeInternet reports offline when DNS fails even if HTTPS would pass", async () => {
  const snap = await probeInternet(
    TARGETS,
    io({ resolveDns: () => Promise.reject(new Error("ENOTFOUND")) }),
  );
  assert.equal(snap.status, "offline");
  assert.ok(snap.error?.includes("DNS lookup failed"));
});

test("probeInternet is unknown (never assumed offline) when disabled", async () => {
  const snap = await probeInternet({ ...TARGETS, enabled: false }, io({}));
  assert.equal(snap.status, "unknown");
  assert.equal(snap.targetClass, "none");
});

test("InternetMonitor.refresh emits a checking transition then the settled result", async () => {
  const emitted: InternetSnapshot[] = [];
  const online: InternetSnapshot = {
    status: "online",
    checking: false,
    checkedAt: "2026-06-26T12:00:00.000Z",
    error: null,
    targetClass: "dns+https",
  };
  const monitor = new InternetMonitor(
    () => Promise.resolve(online),
    30_000,
    () => 0,
    (s) => emitted.push(s),
  );

  const result = await monitor.refresh();
  assert.equal(result.status, "online");
  assert.equal(emitted.length, 2, "one checking emit, one settled emit");
  assert.equal(emitted[0]?.checking, true, "checking starts first");
  assert.equal(emitted[1]?.status, "online", "then the result settles");
  assert.equal(monitor.current().checking, false);
});

test("InternetMonitor.refreshIfStale skips the probe when the snapshot is fresh", async () => {
  let probes = 0;
  const fresh: InternetSnapshot = {
    status: "online",
    checking: false,
    checkedAt: "1970-01-01T00:00:00.000Z",
    error: null,
    targetClass: "dns+https",
  };
  let now = 0;
  const monitor = new InternetMonitor(
    () => {
      probes += 1;
      return Promise.resolve(fresh);
    },
    30_000,
    () => now,
  );

  await monitor.refresh(); // probe #1 at now=0, checkedAt is the epoch
  now = 10_000; // 10s later - within the 30s cache
  await monitor.refreshIfStale();
  assert.equal(probes, 1, "still fresh: no second probe");

  now = 40_000; // 40s later - now stale
  await monitor.refreshIfStale();
  assert.equal(probes, 2, "stale: a fresh probe runs");
});

test("InternetMonitor.refresh dedupes concurrent refreshes", async () => {
  let probes = 0;
  const online: InternetSnapshot = {
    status: "online",
    checking: false,
    checkedAt: "2026-06-26T12:00:00.000Z",
    error: null,
    targetClass: "dns+https",
  };
  const monitor = new InternetMonitor(
    () => {
      probes += 1;
      return Promise.resolve(online);
    },
    30_000,
    () => 0,
  );

  await Promise.all([monitor.refresh(), monitor.refresh()]);
  assert.equal(probes, 1, "the second concurrent refresh joins the first");
});
