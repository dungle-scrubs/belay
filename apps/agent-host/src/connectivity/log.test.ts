import assert from "node:assert/strict";
import type { InternetSnapshot } from "@belay/session";
import { fmtFields } from "@host/transport/log";
import { test } from "vitest";
import { InternetMonitor, type ProbeLogLine } from "./probe";

/**
 * D-060 M4 / D-022: InternetMonitor owns structured, redacted probe log-line emission. It emits a
 * line on status changes and settled failures, suppresses checking starts and unchanged-reachable
 * settles, and exposes only sanitized snapshot fields.
 */

const snap = (over: Partial<InternetSnapshot>): InternetSnapshot => ({
  status: "online",
  checking: false,
  checkedAt: "2026-06-27T00:00:00.000Z",
  error: null,
  targetClass: "dns+https",
  ...over,
});

function monitorFor(results: readonly InternetSnapshot[], lines: ProbeLogLine[]): InternetMonitor {
  let next = 0;
  return new InternetMonitor(
    () => Promise.resolve(results[next++] ?? results[results.length - 1] ?? snap({})),
    0,
    () => 0,
    () => {},
    (line) => lines.push(line),
  );
}

test("a status change logs at the matching level with previous + new status", async () => {
  const lines: ProbeLogLine[] = [];
  const monitor = monitorFor(
    [
      snap({ status: "online" }),
      snap({ status: "offline", error: "DNS lookup failed; HTTPS probe failed" }),
    ],
    lines,
  );

  await monitor.refresh();
  assert.equal(lines[0]?.level, "info");
  assert.equal(lines[0]?.message, "internet status changed");
  assert.equal(lines[0]?.fields.status, "online");
  assert.equal(lines[0]?.fields.previous, "unknown");

  await monitor.refresh();
  assert.equal(lines[1]?.level, "warn", "going offline warns");
  assert.equal(lines[1]?.fields.previous, "online");
  assert.equal(lines[1]?.fields.error, "DNS lookup failed; HTTPS probe failed");
});

test("the checking start and an unchanged reachable settle are not logged", async () => {
  const lines: ProbeLogLine[] = [];
  const monitor = monitorFor([snap({ status: "online" }), snap({ status: "online" })], lines);

  await monitor.refresh();
  assert.equal(lines.length, 1, "unknown -> online is notable");
  await monitor.refresh();
  assert.equal(lines.length, 1, "online -> online settled: steady state stays silent");
});

test("a repeated offline settle logs a probe failure even without a status change", async () => {
  const lines: ProbeLogLine[] = [];
  const monitor = monitorFor(
    [
      snap({ status: "offline", error: "DNS lookup failed" }),
      snap({ status: "offline", error: "HTTPS probe failed" }),
    ],
    lines,
  );

  await monitor.refresh();
  await monitor.refresh();
  const line = lines[1];
  assert.ok(line);
  assert.equal(line.message, "internet probe failed");
  assert.equal(line.level, "warn");
  assert.equal(line.fields.previous, undefined, "no status change -> no previous field");
  assert.equal(line.fields.error, "HTTPS probe failed");
});

test("the rendered line carries the target CLASS, never the configured endpoints or secrets", async () => {
  const lines: ProbeLogLine[] = [];
  const monitor = monitorFor([snap({ status: "offline", error: "HTTPS probe failed" })], lines);

  await monitor.refresh();
  const line = lines[0];
  assert.ok(line);
  const rendered = fmtFields(line.fields);
  assert.ok(rendered.includes("targetClass=dns+https"), "the target class is logged");
  assert.ok(!rendered.includes("https://"), "no HTTPS endpoint leaks");
  assert.ok(
    !rendered.includes("1.1.1.1") && !/dnsHost|httpsUrl/.test(rendered),
    "no raw target fields",
  );
});
