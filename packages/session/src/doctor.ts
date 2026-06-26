/**
 * `/doctor` health-snapshot read model and aggregation helpers.
 *
 * The single source of the shape Trevor web renders for `doctor.current`: the
 * overall snapshot, its twelve diagnostic areas, the findings inside each area,
 * and the pure helpers that roll finding/area severity up into the summary
 * strip. Nothing here renders or probes - the host builds the snapshot, the web
 * dashboard (`components/chat/doctor`) renders it, and this module is the shared
 * vocabulary in between (mirrors `commands/loop.ts`).
 */

/**
 * Severity of a finding, an area, or the whole snapshot. `not_checked` covers
 * both "didn't run" and "timed out / unavailable" - a probe that degrades still
 * lands here, with the reason carried in the finding's message, so the summary
 * keeps four clean buckets.
 */
export type DoctorStatus = "ok" | "warn" | "error" | "not_checked";

/** The twelve diagnostic areas, in their canonical dashboard order. */
export type DoctorAreaId =
  | "core"
  | "session"
  | "providers"
  | "internet"
  | "tools"
  | "web"
  | "mcp"
  | "lsp"
  | "hooks"
  | "storage"
  | "workspace"
  | "updates";

/** Canonical area order; the dashboard renders areas in this sequence so a
 *  returning user always finds each area in the same place. */
export const DOCTOR_AREA_ORDER: readonly DoctorAreaId[] = [
  "core",
  "session",
  "providers",
  "internet",
  "tools",
  "web",
  "mcp",
  "lsp",
  "hooks",
  "storage",
  "workspace",
  "updates",
];

/** Whether the host has a fresh snapshot, is re-probing, or is showing one that
 *  has aged past its freshness window. */
export type DoctorSnapshotState = "ready" | "refreshing" | "stale";

/** One bounded key fact shown on an area card (e.g. `rg` -> `available`). The
 *  optional status tints the value so a missing tool reads at a glance. */
export interface DoctorFact {
  readonly label: string;
  readonly value: string;
  readonly status?: DoctorStatus;
}

/** A repair affordance: what to do next, optionally the exact command to run.
 *  Presentational only - the dashboard renders it; it never executes here. */
export interface DoctorNextAction {
  readonly label: string;
  /** A command or path to surface as the actionable detail, shown monospace. */
  readonly command?: string;
}

/** One actionable check inside an area. The title, status, and message are
 *  always shown; `evidence` is raw detail the card keeps collapsed by default. */
export interface DoctorFinding {
  /** Stable id, e.g. `providers.cloud.unreachable`. */
  readonly id: string;
  readonly status: DoctorStatus;
  /** Human label for the thing checked, e.g. "Cloud provider (GPT-5.5)". */
  readonly title: string;
  /** Concise verdict - why this status, in one line. */
  readonly message: string;
  /** A source path/URL when relevant, rendered monospace and wrap-safe. */
  readonly source?: string;
  /** Raw internals (stack, struct, command output) - secondary, expandable. */
  readonly evidence?: string;
  readonly nextAction?: DoctorNextAction;
}

/** One diagnostic area: a short verdict, a few key facts, and its findings. */
export interface DoctorArea {
  readonly id: DoctorAreaId;
  readonly label: string;
  readonly status: DoctorStatus;
  /** One-line verdict for the area header. */
  readonly verdict: string;
  readonly facts?: readonly DoctorFact[];
  readonly findings?: readonly DoctorFinding[];
  /** An area-level next action when no single finding owns it. */
  readonly nextAction?: DoctorNextAction;
}

/** Area counts by status - the four buckets the summary strip shows. */
export interface DoctorSummary {
  readonly ok: number;
  readonly warn: number;
  readonly error: number;
  readonly notChecked: number;
  /** Total areas (ok + warn + error + notChecked). */
  readonly total: number;
}

/** Optional host context shown beside the summary (workspace, instance, role). */
export interface DoctorHostContext {
  readonly workspace: string;
  readonly instanceId?: string;
  readonly role?: string;
}

/** The full `doctor.current` payload the dashboard renders. */
export interface DoctorSnapshot {
  readonly state: DoctorSnapshotState;
  /** Human freshness label, e.g. "12s ago" or "checked just now". */
  readonly checkedAt?: string;
  readonly host?: DoctorHostContext;
  readonly areas: readonly DoctorArea[];
}

/** Severity precedence: a higher rank dominates when rolling many into one. */
export const DOCTOR_STATUS_RANK: Record<DoctorStatus, number> = {
  error: 3,
  warn: 2,
  ok: 1,
  not_checked: 0,
};

/**
 * The dominant status across a set: any error wins, then any warning, then any
 * ok; all-unchecked stays `not_checked`. Used to derive an area status from its
 * findings and the overall snapshot status from its areas.
 */
export function rollupStatus(statuses: Iterable<DoctorStatus>): DoctorStatus {
  let worst: DoctorStatus = "not_checked";
  for (const status of statuses) {
    if (DOCTOR_STATUS_RANK[status] > DOCTOR_STATUS_RANK[worst]) {
      worst = status;
    }
  }
  return worst;
}

/** The snapshot's overall status: the dominant status across its areas. */
export function overallStatus(snapshot: DoctorSnapshot): DoctorStatus {
  return rollupStatus(snapshot.areas.map((area) => area.status));
}

/** Count the snapshot's areas into the four summary buckets. */
export function summarizeSnapshot(snapshot: DoctorSnapshot): DoctorSummary {
  let ok = 0;
  let warn = 0;
  let error = 0;
  let notChecked = 0;
  for (const area of snapshot.areas) {
    switch (area.status) {
      case "ok":
        ok += 1;
        break;
      case "warn":
        warn += 1;
        break;
      case "error":
        error += 1;
        break;
      case "not_checked":
        notChecked += 1;
        break;
    }
  }
  return { ok, warn, error, notChecked, total: snapshot.areas.length };
}

/** True when an area carries something the user should act on (warn or error).
 *  The "issues only" view keeps exactly these, so errors and warnings can never
 *  be filtered away. */
export function isIssue(area: DoctorArea): boolean {
  return area.status === "warn" || area.status === "error";
}

/**
 * Defensively decodes a `/doctor` command-result string into a {@link DoctorSnapshot}. Returns null
 * for a legacy text dump, an `error:` line, or any non-snapshot body, so the web renders the
 * dashboard only when the host actually sent the structured payload (and the plain text otherwise).
 */
export function decodeDoctorSnapshot(raw: string | undefined): DoctorSnapshot | null {
  if (!raw || raw.startsWith("error:")) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DoctorSnapshot>;
    if (typeof parsed.state === "string" && Array.isArray(parsed.areas)) {
      return parsed as DoctorSnapshot;
    }
  } catch {
    // legacy text dump or truncated JSON; fall through
  }
  return null;
}
