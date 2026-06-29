import assert from "node:assert/strict";
import {
  DOCTOR_AREA_ORDER,
  type InternetSnapshot,
  overallStatus,
  summarizeSnapshot,
} from "@trevor/session";
import { test } from "vitest";
import {
  buildDoctorSnapshot,
  type DoctorProbeInput,
  type DoctorRootProbe,
  type PeripheralState,
} from "./snapshot";

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

function root(over: Partial<DoctorRootProbe> & Pick<DoctorRootProbe, "id">): DoctorRootProbe {
  return {
    label: over.id,
    ownership: "trevor",
    path: `~/.${over.id}`,
    exists: true,
    writable: true,
    overridden: false,
    migrationAvailable: false,
    ...over,
  };
}

/** A healthy resolved root set (sanitized paths) the storage default builds from. */
const HEALTHY_ROOTS: readonly DoctorRootProbe[] = [
  root({ id: "config", label: "config", path: "~/.trevorV2" }),
  root({ id: "state", label: "state", path: "~/.local/state/trevorV2" }),
  root({
    id: "legacy",
    label: "legacy",
    ownership: "trevor",
    path: "~/.trevor",
    exists: false,
    writable: null,
  }),
  root({ id: "temp", label: "temp", path: "/tmp" }),
  root({
    id: "browser",
    label: "browser",
    path: null,
    exists: false,
    writable: true,
  }),
  root({
    id: "external-pi",
    label: "external:pi",
    ownership: "external",
    path: "~/.pi",
    writable: null,
  }),
];

function input(over: Partial<DoctorProbeInput> = {}): DoctorProbeInput {
  return {
    host: { instanceId: "abc12345", role: "leader", live: true },
    session: { activeRun: undefined, queued: 0, lastTurn: "answered" },
    providers: [{ key: "qwen", label: "Qwen", model: "qwen3", kind: "local", status: "warm" }],
    internet: ONLINE,
    tools: ["read", "grep", "bash"],
    workspace: { cwd: "~/dev/trevorV2", workspace: "~/dev/trevorV2", branch: "main" },
    storage: { roots: HEALTHY_ROOTS },
    build: { version: "2.0.0", node: "v22.0.0", runtime: "trevor" },
    peripherals: {
      mcp: { kind: "unconfigured" },
      lsp: { kind: "unconfigured" },
      hooks: { kind: "unconfigured" },
    },
    web: {
      searchConfigured: false,
      fetch: { staticAvailable: true, jina: "available", firecrawl: "unconfigured" },
      docs: { present: false, stale: false },
    },
    checkedAt: "2026-06-26T12:00:00.000Z",
    ...over,
  };
}

test("builds all twelve areas in canonical order, with findings (internet/storage are facts-driven)", () => {
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
    if (area.id === "storage") {
      // Storage/Roots is facts-driven: a fact per root carries the verdict; findings appear only on a
      // problem (a not-writable root or importable legacy data), so a healthy host has none.
      assert.ok((area.facts?.length ?? 0) >= 1, "storage lists root facts");
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
  // The web area now rolls up to ok (static fetch is always ready); mcp/lsp/hooks stay not_checked.
  assert.ok(summary.notChecked >= 3, "mcp/lsp/hooks are not_checked");
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

test("the Web / Docs area reports config presence (enums/booleans only, never key values)", () => {
  // Static fetch always works, so even with no web-search key the area is not an error; the fetch
  // ladder finding is ok (and the unconfigured Firecrawl carries the configure action).
  const none = buildDoctorSnapshot(input()).areas.find((a) => a.id === "web");
  assert.ok(
    none?.findings?.some((f) => f.id === "web.search" && f.nextAction),
    "an unconfigured web-search offers a configure action",
  );
  const noneFetch = none?.findings?.find((f) => f.id === "web.fetch");
  assert.equal(
    noneFetch?.status,
    "ok",
    "the fetch ladder is ready even with no keys (static always)",
  );
  assert.match(noneFetch?.message ?? "", /static/);

  // A fully-configured area renders with no key value anywhere. The env-var NAME hint (e.g.
  // FIRECRAWL_API_KEY) only appears in a configure action when a backend is unconfigured; here every
  // backend is ready, so no env-var name is present either.
  const configured = buildDoctorSnapshot(
    input({
      web: {
        searchConfigured: true,
        fetch: { staticAvailable: true, jina: "keyed", firecrawl: "configured" },
        docs: { present: true, stale: false },
      },
    }),
  ).areas.find((a) => a.id === "web");
  assert.equal(configured?.status, "ok");
  const text = JSON.stringify(configured);
  assert.ok(!/API_KEY|sk-|brave_/i.test(text), "no key value or env-var name leaks into the area");

  // A stale docs cache warns with a refresh action.
  const stale = buildDoctorSnapshot(
    input({
      web: {
        searchConfigured: true,
        fetch: { staticAvailable: true, jina: "available", firecrawl: "configured" },
        docs: { present: true, stale: true },
      },
    }),
  ).areas.find((a) => a.id === "web");
  assert.equal(stale?.status, "warn");
  assert.ok(stale?.findings?.some((f) => f.id === "web.docs" && f.nextAction));
});

test("the Web fetch finding reports the ladder readiness: Jina available vs keyed", () => {
  const available = buildDoctorSnapshot(
    input({
      web: {
        searchConfigured: false,
        fetch: { staticAvailable: true, jina: "available", firecrawl: "unconfigured" },
        docs: { present: false, stale: false },
      },
    }),
  )
    .areas.find((a) => a.id === "web")
    ?.findings?.find((f) => f.id === "web.fetch");
  assert.match(available?.message ?? "", /Jina available/);

  const keyed = buildDoctorSnapshot(
    input({
      web: {
        searchConfigured: false,
        fetch: { staticAvailable: true, jina: "keyed", firecrawl: "unconfigured" },
        docs: { present: false, stale: false },
      },
    }),
  )
    .areas.find((a) => a.id === "web")
    ?.findings?.find((f) => f.id === "web.fetch");
  assert.match(keyed?.message ?? "", /Jina keyed/);
});

test("the Web fetch finding reports Firecrawl configured vs unconfigured", () => {
  const unconfigured = buildDoctorSnapshot(
    input({
      web: {
        searchConfigured: false,
        fetch: { staticAvailable: true, jina: "available", firecrawl: "unconfigured" },
        docs: { present: false, stale: false },
      },
    }),
  )
    .areas.find((a) => a.id === "web")
    ?.findings?.find((f) => f.id === "web.fetch");
  assert.match(unconfigured?.message ?? "", /Firecrawl unconfigured/);
  assert.match(unconfigured?.nextAction?.label ?? "", /FIRECRAWL_API_KEY/);

  const configured = buildDoctorSnapshot(
    input({
      web: {
        searchConfigured: false,
        fetch: { staticAvailable: true, jina: "available", firecrawl: "configured" },
        docs: { present: false, stale: false },
      },
    }),
  )
    .areas.find((a) => a.id === "web")
    ?.findings?.find((f) => f.id === "web.fetch");
  assert.match(configured?.message ?? "", /Firecrawl configured/);
  assert.equal(configured?.nextAction, undefined, "a configured Firecrawl needs no action");
});

test("the Web fetch finding surfaces a sanitized last backend error when present", () => {
  const finding = buildDoctorSnapshot(
    input({
      web: {
        searchConfigured: false,
        fetch: {
          staticAvailable: true,
          jina: "available",
          firecrawl: "unconfigured",
          lastError: "jina error",
        },
        docs: { present: false, stale: false },
      },
    }),
  )
    .areas.find((a) => a.id === "web")
    ?.findings?.find((f) => f.id === "web.fetch");
  assert.match(finding?.message ?? "", /Last backend error: jina error/);
  // Still redaction-safe: a category only, never a key/header/URL-query fragment.
  assert.ok(
    !/API_KEY|sk-|bearer|\?/i.test(finding?.message ?? ""),
    "no secret material in the error",
  );
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

test("the Providers area surfaces D-065 catalog sources: action findings + a redacted overview fact", () => {
  const providers = buildDoctorSnapshot(
    input({
      catalogSources: [
        // configured + ready -> no finding, contributes to the ready count + model total
        {
          sourceId: "deepseek",
          label: "DeepSeek",
          type: "api-key",
          status: "ready",
          auth: "authenticated",
          modelCount: 2,
        },
        {
          sourceId: "ollama",
          label: "Ollama Cloud",
          type: "gateway",
          status: "ready",
          auth: "authenticated",
          modelCount: 35,
        },
        // each of these NEEDS action and the legacy roster can't show them
        {
          sourceId: "minimax",
          label: "MiniMax",
          type: "api-key",
          status: "needs-auth",
          auth: "none",
          modelCount: 0,
        },
        {
          sourceId: "openai",
          label: "OpenAI",
          type: "oauth",
          status: "ready",
          auth: "expired",
          modelCount: 0,
        },
        {
          sourceId: "zai",
          label: "Z.ai",
          type: "api-key",
          status: "error",
          auth: "authenticated",
          modelCount: 0,
        },
      ],
    }),
  ).areas.find((a) => a.id === "providers");

  // ready sources add no finding; unconfigured/expired/rejected each add one actionable finding.
  assert.ok(!providers?.findings?.some((f) => f.id === "providers.source.deepseek"));
  assert.ok(!providers?.findings?.some((f) => f.id === "providers.source.ollama"));

  const minimax = providers?.findings?.find((f) => f.id === "providers.source.minimax");
  assert.equal(minimax?.status, "warn");
  assert.match(minimax?.nextAction?.label ?? "", /Add the MiniMax key to ~\/\.pi\/auth\.json/);

  const openai = providers?.findings?.find((f) => f.id === "providers.source.openai");
  assert.equal(openai?.status, "warn");
  assert.match(openai?.message ?? "", /sign-in has expired/);
  assert.match(openai?.nextAction?.label ?? "", /Sign in to OpenAI/);

  const zai = providers?.findings?.find((f) => f.id === "providers.source.zai");
  assert.equal(zai?.status, "error");
  assert.match(zai?.message ?? "", /rejected/);

  // a rejected source lifts the whole Providers area to error.
  assert.equal(providers?.status, "error");

  // the overview fact agrees with the findings (3 need setup) and totals the live model counts.
  const fact = providers?.facts?.find((f) => f.label === "catalog");
  assert.equal(fact?.value, "5 sources (2 ready, 3 need setup) · 37 models");
});

test("a fully-configured catalog adds only the overview fact and does not warn", () => {
  const providers = buildDoctorSnapshot(
    input({
      catalogSources: [
        {
          sourceId: "deepseek",
          label: "DeepSeek",
          type: "api-key",
          status: "ready",
          auth: "authenticated",
          modelCount: 2,
        },
        {
          sourceId: "lmstudio",
          label: "LM Studio",
          type: "local",
          status: "ready",
          auth: "authenticated",
          modelCount: 12,
        },
      ],
    }),
  ).areas.find((a) => a.id === "providers");
  assert.ok(!providers?.findings?.some((f) => f.id.startsWith("providers.source.")));
  assert.equal(providers?.status, "ok");
  assert.equal(
    providers?.facts?.find((f) => f.label === "catalog")?.value,
    "2 sources (2 ready) · 14 models",
  );
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

test("all-healthy roots roll the Storage area up to ok with one fact per root", () => {
  const area = buildDoctorSnapshot(input()).areas.find((a) => a.id === "storage");
  assert.equal(area?.status, "ok");
  assert.equal(area?.findings?.length ?? 0, 0, "a healthy area carries no problem finding");
  assert.equal(area?.facts?.length, HEALTHY_ROOTS.length, "one fact per resolved root");
  assert.match(area?.verdict ?? "", /resolved and writable/);
  // Sanitized: the home directory is shown as ~, never a raw /Users path or secret.
  assert.ok(!/\/Users\/|\/home\//.test(JSON.stringify(area)), "no raw home path leaks");
});

test("an unwritable state root is an error finding and lifts the Storage area to error", () => {
  const area = buildDoctorSnapshot(
    input({
      storage: {
        roots: HEALTHY_ROOTS.map((r) => (r.id === "state" ? { ...r, writable: false } : r)),
      },
    }),
  ).areas.find((a) => a.id === "storage");
  assert.equal(area?.status, "error");
  const finding = area?.findings?.find((f) => f.id === "storage.state");
  assert.ok(finding, "an unwritable root gets a problem finding");
  assert.equal(finding?.status, "error");
  assert.equal(finding?.source, "~/.local/state/trevorV2");
  assert.equal(finding?.nextAction?.command, "~/.local/state/trevorV2");
  assert.ok(
    area?.facts?.some((f) => f.label === "state" && /not writable/.test(f.value)),
    "the state fact reads not writable",
  );
});

test("an importable legacy root warns with a migration hint", () => {
  const area = buildDoctorSnapshot(
    input({
      storage: {
        roots: HEALTHY_ROOTS.map((r) =>
          r.id === "legacy" ? { ...r, exists: true, migrationAvailable: true } : r,
        ),
      },
    }),
  ).areas.find((a) => a.id === "storage");
  assert.equal(area?.status, "warn");
  const finding = area?.findings?.find((f) => f.id === "storage.legacy");
  assert.equal(finding?.status, "warn");
  assert.match(finding?.message ?? "", /Importable ~\/\.trevor data/);
  assert.match(finding?.nextAction?.label ?? "", /SESSION_STORE_DB \/ BLOB_STORE_DIR/);
  assert.ok(
    area?.facts?.some((f) => f.label === "legacy" && /legacy data \(importable\)/.test(f.value)),
    "the legacy fact reads importable",
  );
});

test("an overridden root marks its fact value", () => {
  const area = buildDoctorSnapshot(
    input({
      storage: {
        roots: HEALTHY_ROOTS.map((r) => (r.id === "state" ? { ...r, overridden: true } : r)),
      },
    }),
  ).areas.find((a) => a.id === "storage");
  const fact = area?.facts?.find((f) => f.label === "state");
  assert.match(fact?.value ?? "", /overridden/, "an overridden writable root says so");
});

test("an external root reads as read-only and adds no finding", () => {
  const area = buildDoctorSnapshot(input()).areas.find((a) => a.id === "storage");
  const fact = area?.facts?.find((f) => f.label === "external:pi");
  assert.match(fact?.value ?? "", /external \(read-only\)/);
  assert.equal(fact?.status, "ok", "an external root is never a problem");
  assert.ok(
    !area?.findings?.some((f) => f.id === "storage.external-pi"),
    "an external root never gets a finding",
  );
});

test("a writable root that does not exist yet is not_checked, not an error", () => {
  const area = buildDoctorSnapshot(
    input({
      storage: {
        roots: HEALTHY_ROOTS.map((r) =>
          r.id === "config" ? { ...r, exists: false, writable: null } : r,
        ),
      },
    }),
  ).areas.find((a) => a.id === "storage");
  const fact = area?.facts?.find((f) => f.label === "config");
  assert.equal(fact?.status, "not_checked");
  assert.match(fact?.value ?? "", /not created yet/);
  assert.notEqual(area?.status, "error", "a not-yet-created root is not an outage");
});

test("the snapshot carries host context + a checked-at stamp and is ready", () => {
  const snap = buildDoctorSnapshot(input());
  assert.equal(snap.state, "ready");
  assert.equal(snap.checkedAt, "2026-06-26T12:00:00.000Z");
  assert.equal(snap.host?.role, "leader");
});

test("D-007: the latest per-provider incident renders a categorized provider finding", () => {
  const providers = buildDoctorSnapshot(
    input({
      providerIncidents: [
        {
          provider: "deepseek",
          model: "deepseek-v4",
          category: "malformed_protocol",
          reason: "protocol_anomaly",
          detail: "DeepSeek rendered tool-call JSON or tags as assistant text",
          attempt: 1,
          at: "2026-06-29T00:00:00.000Z",
        },
      ],
    }),
  ).areas.find((a) => a.id === "providers");

  const finding = providers?.findings?.find((f) => f.id === "providers.incident.deepseek");
  assert.ok(finding, "an incident finding is present");
  assert.match(finding.title, /Malformed provider protocol/);
  assert.match(finding.title, /deepseek/);
  // The sanitized upstream detail rides as collapsed evidence.
  assert.equal(finding.evidence, "DeepSeek rendered tool-call JSON or tags as assistant text");
  assert.ok(finding.nextAction, "a repair action is offered");
});

test("D-007: each incident category maps to its own finding title", () => {
  const cases = [
    ["auth_quota", /Provider auth \/ quota/],
    ["transport", /Provider transport failure/],
    ["malformed_protocol", /Malformed provider protocol/],
    ["unsafe_retry", /Unsafe partial-stream retry/],
  ] as const;
  for (const [category, title] of cases) {
    const providers = buildDoctorSnapshot(
      input({
        providerIncidents: [
          {
            provider: "deepseek",
            category,
            reason: category,
            detail: "detail",
            attempt: 1,
            at: "2026-06-29T00:00:00.000Z",
          },
        ],
      }),
    ).areas.find((a) => a.id === "providers");
    const finding = providers?.findings?.find((f) => f.id === "providers.incident.deepseek");
    assert.ok(finding, `a ${category} finding is present`);
    assert.match(finding.title, title);
  }
});

test("D-007: no provider incidents means no incident findings", () => {
  const providers = buildDoctorSnapshot(input()).areas.find((a) => a.id === "providers");
  assert.ok(!providers?.findings?.some((f) => f.id.startsWith("providers.incident.")));
});

test("D-007: the incident finding surfaces only the sanitized detail, never a credential", () => {
  // The detail is redacted at the provider boundary before it reaches /doctor; the finding evidence
  // is that sanitized string verbatim, so no key/prompt/header can leak through the report.
  const providers = buildDoctorSnapshot(
    input({
      providerIncidents: [
        {
          provider: "deepseek",
          category: "auth_quota",
          reason: "auth",
          detail: "401 from upstream: «redacted»",
          attempt: 1,
          at: "2026-06-29T00:00:00.000Z",
        },
      ],
    }),
  ).areas.find((a) => a.id === "providers");
  const finding = providers?.findings?.find((f) => f.id === "providers.incident.deepseek");
  assert.equal(finding?.evidence, "401 from upstream: «redacted»");
  assert.ok(!/Bearer|sk-|x-api-key/i.test(finding?.evidence ?? ""));
});
