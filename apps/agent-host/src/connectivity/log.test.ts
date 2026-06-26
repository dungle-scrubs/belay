import assert from "node:assert/strict";
import { type InternetSnapshot, UNKNOWN_INTERNET } from "@trevor/session";
import { test } from "vitest";
import { fmtFields } from "../log";
import { probeLogLine } from "./log";

/**
 * D-060 M4: the structured, redacted probe log line. Pins what is logged (status changes + settled
 * failures), what is suppressed (checking start, unchanged-reachable settle), and that no configured
 * endpoint can reach the rendered line.
 */

const snap = (over: Partial<InternetSnapshot>): InternetSnapshot => ({
  status: "online",
  checking: false,
  checkedAt: "2026-06-27T00:00:00.000Z",
  error: null,
  targetClass: "dns+https",
  ...over,
});

test("a status change logs at the matching level with previous + new status", () => {
  const online = probeLogLine(UNKNOWN_INTERNET, snap({ status: "online" }));
  assert.ok(online);
  assert.equal(online.level, "info");
  assert.equal(online.message, "internet status changed");
  assert.equal(online.fields.status, "online");
  assert.equal(online.fields.previous, "unknown");

  const offline = probeLogLine(
    snap({ status: "online" }),
    snap({ status: "offline", error: "DNS lookup failed; HTTPS probe failed" }),
  );
  assert.ok(offline);
  assert.equal(offline.level, "warn", "going offline warns");
  assert.equal(offline.fields.previous, "online");
  assert.equal(offline.fields.error, "DNS lookup failed; HTTPS probe failed");
});

test("the checking start and an unchanged reachable settle are not logged", () => {
  // checking=true is the probe starting - nothing notable yet.
  assert.equal(
    probeLogLine(snap({ status: "online" }), snap({ status: "online", checking: true })),
    null,
  );
  // online -> online settled: steady state stays silent.
  assert.equal(probeLogLine(snap({ status: "online" }), snap({ status: "online" })), null);
});

test("a repeated offline settle logs a probe failure even without a status change", () => {
  const line = probeLogLine(
    snap({ status: "offline", error: "DNS lookup failed" }),
    snap({ status: "offline", error: "HTTPS probe failed" }),
  );
  assert.ok(line);
  assert.equal(line.message, "internet probe failed");
  assert.equal(line.level, "warn");
  assert.equal(line.fields.previous, undefined, "no status change -> no previous field");
  assert.equal(line.fields.error, "HTTPS probe failed");
});

test("the rendered line carries the target CLASS, never the configured endpoints or secrets", () => {
  // Even if a probe somehow carried endpoint-shaped text, the line only echoes the snapshot's own
  // already-sanitized fields - and it logs targetClass, not the DNS host / HTTPS URL.
  const line = probeLogLine(
    snap({ status: "online" }),
    snap({ status: "offline", error: "HTTPS probe failed" }),
  );
  assert.ok(line);
  const rendered = fmtFields(line.fields);
  assert.ok(rendered.includes("targetClass=dns+https"), "the target class is logged");
  assert.ok(!rendered.includes("https://"), "no HTTPS endpoint leaks");
  assert.ok(
    !rendered.includes("1.1.1.1") && !/dnsHost|httpsUrl/.test(rendered),
    "no raw target fields",
  );
});
