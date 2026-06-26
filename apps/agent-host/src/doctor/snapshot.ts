import {
  type DoctorArea,
  type DoctorAreaId,
  type DoctorFinding,
  type DoctorSnapshot,
  type DoctorStatus,
  type InternetSnapshot,
  rollupStatus,
} from "@trevor/session";

/**
 * Builds the structured `doctor.current` snapshot (D-073) from already-probed host facts. PURE over
 * its input so the area/finding/severity construction is deterministic and unit-testable; the
 * command handler owns the bounded, redacted probing (provider readiness, storage writeability) and
 * feeds the results here. Areas the first cut does not probe (web/docs, MCP, LSP, hooks, updates)
 * are reported `not_checked` rather than omitted, so the dashboard always shows the full grid.
 *
 * This is health + repair guidance, NOT raw runtime internals (that stays in host.debugInfo): every
 * value here is a sanitized fact, and findings carry a next action where one applies.
 */

/** One provider's probed reachability, fed in by the command handler. */
export interface DoctorProviderProbe {
  readonly key: string;
  readonly label: string;
  readonly model: string;
  readonly kind: "local" | "cloud";
  readonly status: "warm" | "cold" | "unreachable";
}

export interface DoctorProbeInput {
  readonly host: { readonly instanceId: string; readonly role: string; readonly live: boolean };
  /** The live turn-machine facts (active run, queue, last termination), already string-formatted. */
  readonly session: {
    readonly activeRun?: string;
    readonly queued?: number;
    readonly lastTurn?: string;
    readonly compacting?: boolean;
  };
  readonly providers: readonly DoctorProviderProbe[];
  readonly internet: InternetSnapshot;
  readonly tools: readonly string[];
  readonly workspace: {
    readonly cwd: string;
    readonly workspace: string;
    readonly branch?: string;
  };
  readonly storage: { readonly home: string; readonly writable: boolean };
  readonly checkedAt: string;
}

/** Rolls an area's findings into its header status (any error wins, then warn, then ok). */
function areaStatus(findings: readonly DoctorFinding[]): DoctorStatus {
  return rollupStatus(findings.map((f) => f.status));
}

function area(
  id: DoctorAreaId,
  label: string,
  verdict: string,
  findings: readonly DoctorFinding[],
  facts?: DoctorArea["facts"],
): DoctorArea {
  return {
    id,
    label,
    status: areaStatus(findings),
    verdict,
    findings,
    ...(facts ? { facts } : {}),
  };
}

function coreArea(input: DoctorProbeInput): DoctorArea {
  const finding: DoctorFinding = {
    id: "core.process",
    status: input.host.live ? "ok" : "warn",
    title: "Host process",
    message: input.host.live ? `running as ${input.host.role}` : "connecting…",
  };
  return area(
    "core",
    "Core",
    finding.message,
    [finding],
    [
      { label: "instance", value: input.host.instanceId },
      { label: "role", value: input.host.role },
    ],
  );
}

function sessionArea(input: DoctorProbeInput): DoctorArea {
  const { activeRun, queued, lastTurn, compacting } = input.session;
  // A last-turn reason of error/overflow/noReply is worth a warning; everything else is fine.
  const bad = lastTurn ? /error|overflow|noreply|interrupted/i.test(lastTurn) : false;
  const finding: DoctorFinding = {
    id: "session.run",
    status: bad ? "warn" : "ok",
    title: "Session / run",
    message: activeRun ? "a turn is running" : "idle",
  };
  const facts: DoctorArea["facts"] = [
    { label: "active run", value: activeRun ?? "none" },
    { label: "queued", value: String(queued ?? 0) },
    ...(lastTurn
      ? [{ label: "last turn", value: lastTurn, status: bad ? ("warn" as const) : undefined }]
      : []),
    ...(compacting ? [{ label: "compacting", value: "yes" }] : []),
  ];
  return area("session", "Session / Run", finding.message, [finding], facts);
}

function providersArea(input: DoctorProbeInput): DoctorArea {
  const findings: DoctorFinding[] = input.providers.map((p) => ({
    id: `providers.${p.key}`,
    status: p.status === "unreachable" ? (p.kind === "local" ? "warn" : "error") : "ok",
    title: `${p.label} (${p.model})`,
    message:
      p.status === "unreachable"
        ? p.kind === "local"
          ? "runtime not reachable (start it to use this model)"
          : "unreachable"
        : p.status,
    ...(p.status === "unreachable" && p.kind === "local"
      ? { nextAction: { label: "Start the local runtime (LM Studio)" } }
      : {}),
  }));
  const verdict = findings.length
    ? `${findings.length} source${findings.length === 1 ? "" : "s"}`
    : "no providers";
  return area("providers", "Providers / Models / Auth", verdict, findings);
}

function internetArea(input: DoctorProbeInput): DoctorArea {
  const snap = input.internet;
  const status: DoctorStatus =
    snap.status === "online" ? "ok" : snap.status === "offline" ? "warn" : "not_checked";
  const finding: DoctorFinding = {
    id: "internet.reachability",
    status,
    title: "Public internet",
    message:
      snap.status === "online"
        ? "reachable"
        : snap.status === "offline"
          ? `unreachable${snap.error ? ` (${snap.error})` : ""}`
          : "not probed yet",
  };
  const facts: DoctorArea["facts"] = [
    { label: "status", value: snap.status, status },
    { label: "probe", value: snap.targetClass },
    ...(snap.checkedAt ? [{ label: "checked", value: snap.checkedAt }] : []),
  ];
  return area("internet", "Internet", finding.message, [finding], facts);
}

function toolsArea(input: DoctorProbeInput): DoctorArea {
  const finding: DoctorFinding = {
    id: "tools.core",
    status: input.tools.length > 0 ? "ok" : "warn",
    title: "Core tools",
    message: `${input.tools.length} tools available`,
  };
  return area(
    "tools",
    "Tools / Search",
    finding.message,
    [finding],
    [{ label: "tools", value: input.tools.join(", ") }],
  );
}

function storageArea(input: DoctorProbeInput): DoctorArea {
  const finding: DoctorFinding = {
    id: "storage.home",
    status: input.storage.writable ? "ok" : "error",
    title: "TREVOR_HOME",
    message: input.storage.writable ? "writable" : "not writable",
    source: input.storage.home,
    ...(input.storage.writable
      ? {}
      : { nextAction: { label: "Check permissions on", command: input.storage.home } }),
  };
  return area("storage", "Storage / Roots", finding.message, [finding]);
}

function workspaceArea(input: DoctorProbeInput): DoctorArea {
  const finding: DoctorFinding = {
    id: "workspace.cwd",
    status: "ok",
    title: "Workspace",
    message: input.workspace.branch ? `on ${input.workspace.branch}` : "not a git repository",
    source: input.workspace.workspace,
  };
  const facts: DoctorArea["facts"] = [
    { label: "cwd", value: input.workspace.cwd },
    ...(input.workspace.cwd !== input.workspace.workspace
      ? [{ label: "workspace", value: input.workspace.workspace }]
      : []),
    ...(input.workspace.branch ? [{ label: "branch", value: input.workspace.branch }] : []),
  ];
  return area("workspace", "Workspace", finding.message, [finding], facts);
}

/** A `not_checked` placeholder area for a surface this first cut does not probe. */
function notChecked(id: DoctorAreaId, label: string, verdict: string): DoctorArea {
  return {
    id,
    label,
    status: "not_checked",
    verdict,
    findings: [{ id: `${id}.unchecked`, status: "not_checked", title: label, message: verdict }],
  };
}

export function buildDoctorSnapshot(input: DoctorProbeInput): DoctorSnapshot {
  return {
    state: "ready",
    checkedAt: input.checkedAt,
    host: {
      workspace: input.workspace.workspace,
      instanceId: input.host.instanceId,
      role: input.host.role,
    },
    areas: [
      coreArea(input),
      sessionArea(input),
      providersArea(input),
      internetArea(input),
      toolsArea(input),
      notChecked("web", "Web / Docs", "not probed in this build"),
      notChecked("mcp", "MCP", "no MCP servers configured"),
      notChecked("lsp", "LSP", "not probed in this build"),
      notChecked("hooks", "Hooks", "not probed in this build"),
      storageArea(input),
      workspaceArea(input),
      notChecked("updates", "Updates / Version", "not probed in this build"),
    ],
  };
}
