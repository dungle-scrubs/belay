import assert from "node:assert/strict";
import {
  DOCTOR_AREA_ORDER,
  type InternetSnapshot,
  overallStatus,
  summarizeSnapshot,
} from "@trevor/session";
import { test } from "vitest";
import { buildDoctorSnapshot, type DoctorProbeInput } from "./snapshot";

/**
 * D-073 M1-M3: the structured doctor.current snapshot construction. Pure over probed facts, so these
 * pin the 12-area grid, per-area findings, severity aggregation, and the area-specific status
 * mappings (provider unreachable, offline internet, unwritable storage) without any live probing.
 */

const ONLINE: InternetSnapshot = {
  status: "online",
  checking: false,
  checkedAt: "2026-06-26T12:00:00.000Z",
  error: null,
  targetClass: "dns+https",
};

function input(over: Partial<DoctorProbeInput> = {}): DoctorProbeInput {
  return {
    host: { instanceId: "abc12345", role: "leader", live: true },
    session: { activeRun: undefined, queued: 0, lastTurn: "answered" },
    providers: [{ key: "qwen", label: "Qwen", model: "qwen3", kind: "local", status: "warm" }],
    internet: ONLINE,
    tools: ["read", "grep", "bash"],
    workspace: { cwd: "~/dev/trevorV2", workspace: "~/dev/trevorV2", branch: "main" },
    storage: { home: "~/.trevorV2", writable: true },
    build: { version: "2.0.0", node: "v22.0.0", runtime: "trevor" },
    checkedAt: "2026-06-26T12:00:00.000Z",
    ...over,
  };
}

test("builds all twelve areas in canonical order, each with at least one finding", () => {
  const snap = buildDoctorSnapshot(input());
  assert.deepEqual(
    snap.areas.map((a) => a.id),
    DOCTOR_AREA_ORDER,
    "every area is present in the canonical dashboard order",
  );
  for (const area of snap.areas) {
    assert.ok((area.findings?.length ?? 0) >= 1, `area ${area.id} has a finding`);
  }
});

test("an all-healthy snapshot rolls up to ok (unprobed areas are not_checked, not error)", () => {
  const snap = buildDoctorSnapshot(input());
  assert.equal(overallStatus(snap), "ok", "ok dominates the not_checked placeholders");
  const summary = summarizeSnapshot(snap);
  assert.equal(summary.error, 0);
  assert.ok(summary.notChecked >= 4, "web/mcp/lsp/hooks are not_checked");
});

test("the Updates / Version area reports build facts ok when a version is embedded", () => {
  const snap = buildDoctorSnapshot(input());
  const updates = snap.areas.find((a) => a.id === "updates");
  assert.equal(updates?.status, "ok", "a known version + Node/runtime facts roll up to ok");
  assert.ok(
    updates?.facts?.some((f) => f.label === "Trevor" && f.value === "2.0.0"),
    "the embedded version is a fact",
  );
  assert.ok(
    updates?.facts?.some((f) => f.label === "Node"),
    "the Node version is a fact",
  );
  // Update availability is explicitly NOT probed (never implies up-to-date).
  assert.ok(
    updates?.findings?.some((f) => f.id === "updates.check" && f.status === "not_checked"),
    "the update check is reported as not checked",
  );
});

test("a dev build with no embedded version reports the Updates area as not_checked", () => {
  const snap = buildDoctorSnapshot(
    input({ build: { version: null, node: "v22.0.0", runtime: "trevor" } }),
  );
  const updates = snap.areas.find((a) => a.id === "updates");
  assert.equal(
    updates?.status,
    "not_checked",
    "no version + no update check -> not_checked, never ok",
  );
  assert.match(updates?.verdict ?? "", /dev build/i);
});

test("an unreachable local runtime warns, an unreachable cloud provider errors", () => {
  const local = buildDoctorSnapshot(
    input({
      providers: [{ key: "qwen", label: "Qwen", model: "q", kind: "local", status: "unreachable" }],
    }),
  );
  const localArea = local.areas.find((a) => a.id === "providers");
  assert.equal(localArea?.status, "warn", "a local runtime down is a warning, not an outage");
  assert.ok(localArea?.findings?.[0]?.nextAction, "with a next action to start the runtime");

  const cloud = buildDoctorSnapshot(
    input({
      providers: [{ key: "gpt", label: "GPT", model: "g", kind: "cloud", status: "unreachable" }],
    }),
  );
  assert.equal(cloud.areas.find((a) => a.id === "providers")?.status, "error");
});

test("offline internet warns; unknown is not_checked", () => {
  const offline = buildDoctorSnapshot(
    input({ internet: { ...ONLINE, status: "offline", error: "HTTPS probe failed" } }),
  );
  const area = offline.areas.find((a) => a.id === "internet");
  assert.equal(area?.status, "warn");
  assert.ok(
    area?.findings?.[0]?.message.includes("HTTPS probe failed"),
    "the sanitized reason shows",
  );

  const unknown = buildDoctorSnapshot(
    input({ internet: { ...ONLINE, status: "unknown", checkedAt: null } }),
  );
  assert.equal(unknown.areas.find((a) => a.id === "internet")?.status, "not_checked");
});

test("unwritable storage is an error with a next action and a source path", () => {
  const snap = buildDoctorSnapshot(input({ storage: { home: "~/.trevorV2", writable: false } }));
  const area = snap.areas.find((a) => a.id === "storage");
  assert.equal(area?.status, "error");
  assert.equal(area?.findings?.[0]?.source, "~/.trevorV2");
  assert.ok(area?.findings?.[0]?.nextAction);
});

test("the snapshot carries host context + a checked-at stamp and is ready", () => {
  const snap = buildDoctorSnapshot(input());
  assert.equal(snap.state, "ready");
  assert.equal(snap.checkedAt, "2026-06-26T12:00:00.000Z");
  assert.equal(snap.host?.role, "leader");
});
