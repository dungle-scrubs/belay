import type { DoctorArea, DoctorFinding, DoctorNextAction } from "@belay/session";
import {
  CWD_LOCK_FORCE_CLEAR_HINT,
  type CwdLockDoctorFact,
  cwdLockSummary,
  isCwdLockWarn,
} from "@host/session/cwd-lock";
import { area } from "./area";
import type { DoctorProbeInput } from "./probe-input";

/**
 * The host-process/session areas of the /doctor grid (D-073): Core (the host process + role),
 * Session / Run (the live turn-machine facts + last-termination guidance), Tools / Search (the
 * registered tool roster), and Workspace (cwd/branch + the cwd advisory lock, plan 01). Pure folds
 * over {@link DoctorProbeInput} - the probing happened upstream in build.ts.
 *
 * Responsible for: the Core, Session/Run, Tools/Search, and Workspace areas.
 * Not for: provider health (areas-providers.ts), connectivity/integrations (areas-connectivity.ts),
 * or storage/admission/telemetry/updates (areas-platform.ts).
 */

export function coreArea(input: DoctorProbeInput): DoctorArea {
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

function lastTurnCause(lastTurn: string | undefined): string | undefined {
  return lastTurn?.match(/^([a-z_]+):/)?.[1];
}

function lastTurnNextAction(cause: string | undefined): DoctorNextAction | undefined {
  switch (cause) {
    case "step_backstop":
      return { label: "Continue with a follow-up prompt or narrow the task" };
    case "context_pressure":
      return { label: "Continue chatting, or run /compact for more tool room" };
    case "loop_stalled":
      return { label: "Inspect repeated tool calls and continue with a narrower instruction" };
    case "provider_protocol_anomaly":
      return { label: "Inspect provider diagnostics or switch models before retrying" };
    case "overflow":
      return { label: "Run /compact or reduce context before retrying" };
    default:
      return undefined;
  }
}

export function sessionArea(input: DoctorProbeInput): DoctorArea {
  const { activeRun, queued, lastTurn, compacting } = input.session;
  const cause = lastTurnCause(lastTurn);
  const bad = lastTurn
    ? /error|overflow|noreply|interrupted|context_pressure|step_backstop|loop_stalled|provider_protocol_anomaly/i.test(
        lastTurn,
      )
    : false;
  const finding: DoctorFinding = {
    id: "session.run",
    status: bad ? "warn" : "ok",
    title: "Session / run",
    message: activeRun ? "a turn is running" : "idle",
    ...(bad && lastTurn ? { evidence: lastTurn } : {}),
    ...(bad ? { nextAction: lastTurnNextAction(cause) } : {}),
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

export function toolsArea(input: DoctorProbeInput): DoctorArea {
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

/** A cwd-lock finding for the Workspace area, only when the lock is contended or stale (both advisory
 *  warnings - a held or unlocked directory needs no finding, just the fact row). */
function cwdLockFinding(lock: CwdLockDoctorFact | undefined): DoctorFinding[] {
  if (!lock || !isCwdLockWarn(lock.state)) {
    return [];
  }
  return [
    {
      id: "workspace.cwd-lock",
      status: "warn",
      title: lock.state === "contended" ? "Cwd lock contended" : "Stale cwd lock",
      message:
        lock.state === "contended"
          ? "another live session owns this working directory"
          : "a leftover lock from a dead/abandoned owner (reclaimed on next acquire)",
      ...(lock.owner ? { source: lock.owner } : {}),
      nextAction: {
        label: `Inspect the owning host; ${CWD_LOCK_FORCE_CLEAR_HINT}`,
        ...(lock.path ? { command: lock.path } : {}),
      },
    },
  ];
}

export function workspaceArea(input: DoctorProbeInput): DoctorArea {
  const lock = input.workspace.cwdLock;
  const finding: DoctorFinding = {
    id: "workspace.cwd",
    status: "ok",
    title: "Workspace",
    message: input.workspace.branch ? `on ${input.workspace.branch}` : "not a git repository",
    source: input.workspace.workspace,
  };
  const lockWarn = isCwdLockWarn(lock?.state);
  const facts: DoctorArea["facts"] = [
    { label: "cwd", value: input.workspace.cwd },
    ...(input.workspace.cwd !== input.workspace.workspace
      ? [{ label: "workspace", value: input.workspace.workspace }]
      : []),
    ...(input.workspace.branch ? [{ label: "branch", value: input.workspace.branch }] : []),
    ...(lock
      ? [
          {
            label: "cwd lock",
            value: cwdLockSummary(lock),
            ...(lockWarn ? { status: "warn" as const } : {}),
          },
        ]
      : []),
  ];
  return area("workspace", "Workspace", finding.message, [finding, ...cwdLockFinding(lock)], facts);
}
