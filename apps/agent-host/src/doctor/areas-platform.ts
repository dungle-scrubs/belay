import {
  type DoctorArea,
  type DoctorFact,
  type DoctorFinding,
  type DoctorStatus,
  rollupStatus,
} from "@trevor/session";
import type { ResidencyDoctorSummary } from "../residency/doctor";
import { area } from "./area";
import type { DoctorProbeInput, DoctorRootProbe, StoreDiagProbe } from "./probe-input";

/**
 * The machine/platform areas of the /doctor grid: Storage / Roots (per-root health off the root
 * policy, D-005), Local admission (who holds each local runtime plus the resident Trevor-loaded
 * models, plans 11 + 11.1), Telemetry (exporter mode + the redaction self-test, plan 13 M7), and
 * Updates / Version (build facts, with update availability explicitly not probed). Pure folds over
 * {@link DoctorProbeInput} - the probing happened upstream in build.ts / host-facts.ts.
 *
 * Responsible for: the Storage/Roots, Local admission, Telemetry, and Updates/Version areas.
 * Not for: probing roots/admission/telemetry - build.ts and host-facts.ts gather those facts.
 */

/** A root's status + display value: ownership, lifecycle (legacy), and writability drive the verdict. */
function rootFact(root: DoctorRootProbe): {
  readonly status: DoctorStatus;
  readonly value: string;
} {
  if (root.ownership === "external") {
    return { status: "ok", value: `${root.path} · external (read-only)` };
  }
  if (root.path === null) {
    return { status: "ok", value: "browser storage (ephemeral)" };
  }
  if (root.id === "legacy") {
    if (root.migrationAvailable) {
      return { status: "warn", value: `${root.path} · legacy data (importable)` };
    }
    return root.exists
      ? { status: "ok", value: `${root.path} · legacy data present` }
      : { status: "not_checked", value: `${root.path} · none` };
  }
  // A writable Trevor root (config/state/temp): not-created-yet and unwritable are the only problems.
  const base = !root.exists
    ? { status: "not_checked" as const, value: `${root.path} · not created yet` }
    : root.writable === false
      ? { status: "error" as const, value: `${root.path} · not writable` }
      : { status: "ok" as const, value: root.path };
  return root.overridden ? { ...base, value: `${base.value} · overridden` } : base;
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "unknown";
}

function storeDiagParts(store: StoreDiagProbe | undefined): {
  readonly facts: readonly DoctorFact[];
  readonly findings: readonly DoctorFinding[];
  readonly unknown: boolean;
} {
  if (!store) {
    return { facts: [], findings: [], unknown: false };
  }
  if (store.kind === "unknown") {
    return {
      facts: [
        {
          label: "session-store",
          value: `diag unknown (${store.reason})`,
          status: "not_checked",
        },
      ],
      findings: [],
      unknown: true,
    };
  }

  const { diag, hostSha } = store;
  const shaMismatch = diag.startupSha !== null && hostSha !== null && diag.startupSha !== hostSha;
  const status: DoctorStatus = diag.indexHealthy && !shaMismatch ? "ok" : "warn";
  const facts: DoctorFact[] = [
    {
      label: "session-store",
      value:
        `diag ${status === "ok" ? "ok" : "drift"} · schema ${diag.schemaVersion}` +
        ` · store ${shortSha(diag.startupSha)} · ${diag.queries} queries` +
        ` · ${diag.slowQueries} slow`,
      status,
    },
  ];
  const findings: DoctorFinding[] = [];
  if (!diag.indexHealthy) {
    findings.push({
      id: "storage.store.index",
      status: "warn",
      title: "Session-store index drift",
      message: "Hot inventory lookup is not using events_session_type_seq.",
      nextAction: { label: "Restart the session-store from the current checkout" },
    });
  }
  if (shaMismatch) {
    findings.push({
      id: "storage.store.sha",
      status: "warn",
      title: "Session-store code drift",
      message: `session-store is running ${shortSha(diag.startupSha)} while host HEAD is ${shortSha(
        hostSha,
      )}.`,
      nextAction: { label: "Restart the session-store from the current checkout" },
    });
  }
  return { facts, findings, unknown: false };
}

/**
 * The Storage / Roots area (D-005): one fact per resolved root with its health, plus problem-only
 * findings (an unwritable Trevor root errors; importable ~/.trevor data warns with a migration hint).
 * External roots read as read-only and never warn; a not-yet-created root is `not_checked`, not an
 * error. The area status rolls up from the per-root fact statuses, and every path is already
 * home-abbreviated by the probe, so no raw home directory leaks into the diagnostics.
 */
export function storageArea(input: DoctorProbeInput): DoctorArea {
  const roots = input.storage.roots;
  const store = storeDiagParts(input.storage.store);
  const facts: DoctorFact[] = roots.map((root) => {
    const { status, value } = rootFact(root);
    return { label: root.label, value, status };
  });
  facts.push(...store.facts);

  const findings: DoctorFinding[] = [];
  for (const root of roots) {
    if (root.writable === false) {
      findings.push({
        id: `storage.${root.id}`,
        status: "error",
        title: `${root.label} not writable`,
        message: "Trevor cannot write this root.",
        source: root.path ?? undefined,
        nextAction: { label: "Check permissions on", command: root.path ?? undefined },
      });
    }
    if (root.id === "legacy" && root.migrationAvailable) {
      findings.push({
        id: "storage.legacy",
        status: "warn",
        title: "Legacy data",
        message: "Importable ~/.trevor data is present.",
        source: root.path ?? undefined,
        nextAction: {
          label: "Import ~/.trevor data via migration or set SESSION_STORE_DB / BLOB_STORE_DIR",
        },
      });
    }
  }
  findings.push(...store.findings);

  const rolledStatus = rollupStatus(facts.map((f) => f.status ?? "not_checked"));
  const statusOverride = store.unknown && rolledStatus === "ok" ? "not_checked" : rolledStatus;
  const verdict =
    statusOverride === "error"
      ? "A storage root needs attention."
      : statusOverride === "warn"
        ? findings.some((f) => f.id.startsWith("storage.store."))
          ? "Session-store drift detected."
          : "Legacy data is importable."
        : statusOverride === "not_checked"
          ? "Session-store diag unknown."
          : "All roots resolved and writable.";
  return area("storage", "Storage / Roots", verdict, findings, facts, statusOverride);
}

/** Residency findings + facts for the Local-admission area (plan 11.1 M6): the Trevor-loaded models this
 *  instance keeps resident, their context caps + live claim counts, and the last eviction. Returns an
 *  empty split when nothing is resident, so the area is idle only when BOTH admission and residency are. */
function residencyParts(r: ResidencyDoctorSummary | undefined): {
  readonly verdict: string | null;
  readonly findings: readonly DoctorFinding[];
  readonly facts: readonly DoctorFact[];
} {
  if (!r || r.residentModels === 0) {
    return { verdict: null, findings: [], facts: [] };
  }
  const verdict = `${r.residentModels} model${r.residentModels === 1 ? "" : "s"} resident`;
  const findings: DoctorFinding[] = [
    { id: "residency.summary", status: "ok", title: "Resident local models", message: verdict },
  ];
  const facts: DoctorFact[] = [
    { label: "resident models", value: String(r.residentModels) },
    ...r.rows.map((row) => ({
      label: row.model,
      value: `${row.contextLength} ctx, ${row.claims} claim${row.claims === 1 ? "" : "s"}`,
    })),
    ...(r.lastEviction
      ? [{ label: "last eviction", value: `${r.lastEviction.model} (${r.lastEviction.at})` }]
      : []),
  ];
  return { verdict, findings, facts };
}

/** The local-model admission area (plan 11 M8 + 11.1 M6): who holds each local runtime, how deep the
 *  queue is, the oldest wait, a warn when a crashed holder still occupies a slot - and the resident
 *  Trevor-loaded models (context caps, live claim counts, last eviction). No admission AND no residency
 *  reads as a clean "idle". */
export function admissionArea(input: DoctorProbeInput): DoctorArea {
  const a = input.admission;
  const residency = residencyParts(input.residency);
  const hasAdmission = !!a && a.resources > 0;
  if (!hasAdmission && residency.verdict === null) {
    const finding: DoctorFinding = {
      id: "admission.idle",
      status: "ok",
      title: "Local admission",
      message: "no local model in use",
    };
    return area("admission", "Local admission", finding.message, [finding]);
  }
  const findings: DoctorFinding[] = [];
  const facts: DoctorFact[] = [];
  let admissionVerdict: string | null = null;
  if (hasAdmission && a) {
    const stale = a.staleOwners > 0;
    admissionVerdict =
      `${a.activeOwners} active, ${a.queued} queued` +
      (a.queued > 0 ? ` (oldest wait ${Math.round(a.oldestWaitMs / 1000)}s)` : "");
    findings.push({
      id: "admission.summary",
      status: stale ? "warn" : "ok",
      title: "Local admission",
      message: admissionVerdict,
    });
    if (stale) {
      findings.push({
        id: "admission.stale",
        status: "warn",
        title: "Stale local-model owner",
        message: `${a.staleOwners} active owner(s) have no live process; reclaimed on the next acquire`,
      });
    }
    facts.push(
      { label: "resources", value: String(a.resources) },
      { label: "active owners", value: String(a.activeOwners) },
      {
        label: "queued",
        value: String(a.queued),
        ...(a.queued > 0 ? { status: "warn" as const } : {}),
      },
      ...a.rows.map((row) => ({
        label: row.key,
        value:
          `${row.active}/${row.capacity} active, ${row.queued} queued` +
          (row.staleActive > 0 ? `, ${row.staleActive} stale` : ""),
        ...(row.staleActive > 0 ? { status: "warn" as const } : {}),
      })),
    );
  }
  findings.push(...residency.findings);
  facts.push(...residency.facts);
  const verdict = [admissionVerdict, residency.verdict].filter(Boolean).join("; ");
  return area("admission", "Local admission", verdict, findings, facts);
}

/** The Telemetry area (plan 13 M7): the exporter mode, remote/Sentry/provider-trace posture, exporter
 *  drop count, and the redaction self-test. Redaction-safe - no DSN, endpoint, prompt, or path. A
 *  disabled default reads as a clean "local-only, nothing remote". */
export function telemetryArea(input: DoctorProbeInput): DoctorArea {
  const t = input.telemetry;
  if (!t) {
    return area("telemetry", "Telemetry", "not probed", [
      {
        id: "telemetry.idle",
        status: "not_checked",
        title: "Telemetry",
        message: "telemetry state not probed",
      },
    ]);
  }
  const disabled = t.exporter === "none" && !t.sentryConfigured && !t.remoteEnabled;
  const verdict = disabled
    ? "disabled (local-only default; nothing remote)"
    : `${t.exporter} exporter` +
      (t.sentryConfigured ? " + Sentry" : "") +
      (t.suppressed ? ` (remote off: ${t.suppressed})` : "");
  const findings: DoctorFinding[] = [
    {
      id: "telemetry.mode",
      status: "ok",
      title: "Telemetry",
      message: verdict,
    },
    ...(t.redactionOk
      ? []
      : [
          {
            id: "telemetry.redaction",
            status: "error" as const,
            title: "Redaction self-test",
            message:
              "the telemetry redaction self-test FAILED; telemetry should be treated as unsafe",
          },
        ]),
    ...(t.drops > 0
      ? [
          {
            id: "telemetry.drops",
            status: "warn" as const,
            title: "Exporter drops",
            message: `${t.drops} telemetry record(s) dropped (byte cap or write failure)`,
          },
        ]
      : []),
  ];
  const facts: DoctorArea["facts"] = [
    { label: "exporter", value: t.exporter },
    { label: "remote", value: t.remoteEnabled ? "enabled" : "off" },
    { label: "sentry", value: t.sentryConfigured ? "configured" : "off" },
    { label: "provider trace", value: t.providerTrace ? "on" : "off" },
    { label: "drops", value: String(t.drops), ...(t.drops > 0 ? { status: "warn" as const } : {}) },
    {
      label: "redaction self-test",
      value: t.redactionOk ? "pass" : "fail",
      ...(t.redactionOk ? {} : { status: "error" as const }),
    },
  ];
  return area("telemetry", "Telemetry", verdict, findings, facts);
}

/**
 * The Updates / Version area (D-073): the package/build/version facts that ARE available (host build
 * version, runtime kind, Node version), plus an explicit note that this build does not query for a
 * newer release. A dev build with no embedded version reports the version finding as `not_checked`
 * (so it never implies up-to-date), while the Node/runtime facts always render.
 */
export function updatesArea(input: DoctorProbeInput): DoctorArea {
  const b = input.build;
  const facts: DoctorArea["facts"] = [
    { label: "Trevor", value: b.version ?? "dev build", status: b.version ? "ok" : "not_checked" },
    { label: "Runtime", value: b.runtime },
    { label: "Node", value: b.node },
  ];
  const version: DoctorFinding = {
    id: "updates.version",
    status: b.version ? "ok" : "not_checked",
    title: "Version",
    message: b.version
      ? `Running Trevor ${b.version}.`
      : "No build version is embedded (a local dev build).",
  };
  // Update availability is deliberately NOT probed (it would need a network call /doctor does not
  // make), so the area is explicit that it has not checked for a newer release rather than implying
  // the build is current.
  const check: DoctorFinding = {
    id: "updates.check",
    status: "not_checked",
    title: "Update check",
    message: "Not checked - /doctor does not query for newer releases.",
  };
  return area("updates", "Updates / Version", version.message, [version, check], facts);
}
