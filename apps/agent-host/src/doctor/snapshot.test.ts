import assert from "node:assert/strict";
import {
  DOCTOR_AREA_ORDER,
  type InternetSnapshot,
  overallStatus,
  summarizeSnapshot,
} from "@trevor/session";
import { test } from "vitest";
import { buildDoctorSnapshot, type DoctorProbeInput, type PeripheralState } from "./snapshot";

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
    peripherals: {
      mcp: { kind: "unconfigured" },
      lsp: { kind: "unconfigured" },
      hooks: { kind: "unconfigured" },
    },
    web: { searchConfigured: false, fetchProvider: null, docs: { present: false, stale: false } },
    checkedAt: "2026-06-26T12:00:00.000Z",
    ...over,
  };
}

test("builds all twelve areas in canonical order, with findings (internet is binary)", () => {
  const snap = buildDoctorSnapshot(input());
  assert.deepEqual(
    snap.areas.map((a) => a.id),
    DOCTOR_AREA_ORDER,
    "every area is present in the canonical dashboard order",
  );
  for (const area of snap.areas) {
    if (area.id === "internet") {
      // Internet is binary - its verdict carries online/offline directly, no redundant finding row.
      assert.equal(area.findings?.length ?? 0, 0, "internet has no finding");
      continue;
    }
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

test("the Web / Docs area reports config presence (names/booleans only, never key values)", () => {
  // Unconfigured: every dependency is not_checked, so the whole area is not_checked (not an error).
  const none = buildDoctorSnapshot(input()).areas.find((a) => a.id === "web");
  assert.equal(none?.status, "not_checked");
  assert.ok(
    none?.findings?.some((f) => f.id === "web.search" && f.nextAction),
    "an unconfigured web-search offers a configure action",
  );

  // A configured search key lifts the area to ok; the finding carries no key value.
  const configured = buildDoctorSnapshot(
    input({
      web: { searchConfigured: true, fetchProvider: "Jina", docs: { present: true, stale: false } },
    }),
  ).areas.find((a) => a.id === "web");
  assert.equal(configured?.status, "ok");
  const text = JSON.stringify(configured);
  assert.ok(text.includes("Jina"), "the provider name renders");
  assert.ok(!/API_KEY|sk-|brave_/i.test(text), "no key value or env-var name leaks into the area");

  // A stale docs cache warns with a refresh action.
  const stale = buildDoctorSnapshot(
    input({
      web: { searchConfigured: true, fetchProvider: null, docs: { present: true, stale: true } },
    }),
  ).areas.find((a) => a.id === "web");
  assert.equal(stale?.status, "warn");
  assert.ok(stale?.findings?.some((f) => f.id === "web.docs" && f.nextAction));
});

test("the Providers area surfaces unclassified-failure observation counts as a redacted fact (D-076 M6)", () => {
  // No observations: no observations fact (only the provider findings).
  const clean = buildDoctorSnapshot(input()).areas.find((a) => a.id === "providers");
  assert.ok(
    !clean?.facts?.some((f) => f.label === "observations"),
    "no observations fact when nothing has been observed",
  );

  // With observed unknown shapes: a counts-only fact, and the area stays ok (a breadcrumb, not a fault).
  const withObs = buildDoctorSnapshot(
    input({ observations: { distinct: 3, unknown: 12, total: 15 } }),
  ).areas.find((a) => a.id === "providers");
  const fact = withObs?.facts?.find((f) => f.label === "observations");
  assert.ok(fact, "an observations fact is present");
  assert.match(fact?.value ?? "", /3 unclassified shapes/);
  assert.match(fact?.value ?? "", /12 sightings/);
  assert.equal(
    withObs?.status,
    "ok",
    "an unknown-shape breadcrumb does not inflate the area severity",
  );
  // Counts only - no fingerprint, message, or any secret-bearing field leaks into the area.
  assert.ok(!/«|sk-|bearer|token/i.test(JSON.stringify(withObs)), "no secret material in the area");
});

test("the Providers area shows retry exhaustion separately from non-retryable terminal failures (D-076 M6)", () => {
  // Nothing recorded: neither finding appears.
  const clean = buildDoctorSnapshot(input()).areas.find((a) => a.id === "providers");
  assert.ok(!clean?.findings?.some((f) => f.id === "providers.retryExhausted"));
  assert.ok(!clean?.findings?.some((f) => f.id === "providers.terminal"));

  // Both kinds recorded: two DISTINCT findings, each with its own count + sanitized detail.
  const both = buildDoctorSnapshot(
    input({
      providerFailures: {
        retryExhausted: 2,
        nonRetryableTerminal: 1,
        lastRetryExhausted: "codex unavailable: websocket 1006 closed",
        lastTerminal: "codex unavailable: invalid request",
      },
    }),
  ).areas.find((a) => a.id === "providers");
  const exhausted = both?.findings?.find((f) => f.id === "providers.retryExhausted");
  const terminal = both?.findings?.find((f) => f.id === "providers.terminal");
  assert.ok(exhausted, "a retry-exhaustion finding is present");
  assert.ok(terminal, "a separate non-retryable terminal finding is present");
  assert.notEqual(exhausted?.id, terminal?.id, "the two are distinct findings");
  assert.match(exhausted?.message ?? "", /2 turns exhausted/);
  assert.match(terminal?.message ?? "", /1 turn ended/);
  assert.equal(exhausted?.evidence, "codex unavailable: websocket 1006 closed");
  assert.ok(exhausted?.nextAction, "retry exhaustion offers a next action");
  // The source-count verdict still reflects the providers, not the extra failure findings.
  assert.match(both?.verdict ?? "", /1 source/);

  // Only retry exhaustion (no terminal): just that one finding.
  const onlyExhausted = buildDoctorSnapshot(
    input({ providerFailures: { retryExhausted: 1, nonRetryableTerminal: 0 } }),
  ).areas.find((a) => a.id === "providers");
  assert.ok(onlyExhausted?.findings?.some((f) => f.id === "providers.retryExhausted"));
  assert.ok(!onlyExhausted?.findings?.some((f) => f.id === "providers.terminal"));
});

test("the Session area explains the latest non-answered adaptive stop", () => {
  const session = buildDoctorSnapshot(
    input({
      session: {
        activeRun: undefined,
        queued: 0,
        lastTurn: "step_backstop: Paused at the 32-step backstop before context pressure.",
      },
    }),
  ).areas.find((a) => a.id === "session");
  assert.equal(session?.status, "warn");
  const finding = session?.findings?.find((f) => f.id === "session.run");
  assert.equal(
    finding?.evidence,
    "step_backstop: Paused at the 32-step backstop before context pressure.",
  );
  assert.match(finding?.nextAction?.label ?? "", /Continue/);
  assert.ok(
    session?.facts?.some((f) => f.label === "last turn" && f.status === "warn"),
    "the last turn fact is visibly marked",
  );
});

test("the Session area has next-action text for adaptive stop causes", () => {
  for (const cause of [
    "context_pressure",
    "step_backstop",
    "loop_stalled",
    "provider_protocol_anomaly",
    "overflow",
  ]) {
    const session = buildDoctorSnapshot(
      input({ session: { activeRun: undefined, queued: 0, lastTurn: `${cause}: summary` } }),
    ).areas.find((a) => a.id === "session");
    const finding = session?.findings?.find((f) => f.id === "session.run");
    assert.ok(finding?.nextAction?.label, `${cause} has next-action text`);
  }
});

test("MCP/LSP/Hooks areas map each peripheral state to the right status + next action", () => {
  const mcpState = (state: PeripheralState) => {
    const snap = buildDoctorSnapshot(
      input({
        peripherals: { mcp: state, lsp: { kind: "unconfigured" }, hooks: { kind: "unconfigured" } },
      }),
    );
    return snap.areas.find((a) => a.id === "mcp");
  };

  // unconfigured + timeout stay not_checked (never a false error); ready is ok.
  assert.equal(mcpState({ kind: "unconfigured" })?.status, "not_checked");
  assert.equal(mcpState({ kind: "timeout" })?.status, "not_checked");
  assert.equal(mcpState({ kind: "ready", detail: "2 servers" })?.status, "ok");

  // unavailable + auth-needed warn with a repair action; error is an error with one.
  const unavailable = mcpState({ kind: "unavailable" });
  assert.equal(unavailable?.status, "warn");
  assert.ok(
    unavailable?.findings?.[0]?.nextAction,
    "an unavailable peripheral offers a next action",
  );

  const authNeeded = mcpState({ kind: "auth-needed" });
  assert.equal(authNeeded?.status, "warn");
  assert.match(authNeeded?.findings?.[0]?.nextAction?.label ?? "", /[Aa]uthenticate/);

  const errored = mcpState({ kind: "error", detail: "handshake failed" });
  assert.equal(errored?.status, "error");
  assert.equal(errored?.findings?.[0]?.message, "handshake failed", "the sanitized detail shows");
});

test("an error in a peripheral area lifts the whole snapshot to error", () => {
  const snap = buildDoctorSnapshot(
    input({
      peripherals: {
        mcp: { kind: "unconfigured" },
        lsp: { kind: "error", detail: "language server crashed" },
        hooks: { kind: "unconfigured" },
      },
    }),
  );
  assert.equal(overallStatus(snap), "error", "a peripheral error dominates the overall status");
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
  assert.equal(area?.verdict, "offline", "the resting line is binary, not the probe detail");
  assert.equal(area?.findings?.length ?? 0, 0, "no redundant finding row repeating the verdict");
  assert.ok(
    area?.facts?.some((f) => f.label === "detail" && f.value.includes("HTTPS probe failed")),
    "the sanitized reason is a collapsed fact, available on expand",
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
