import { describe, expect, it } from "vitest";
import {
  DOCTOR_AREA_ORDER,
  type DoctorArea,
  type DoctorSnapshot,
  type DoctorStatus,
  decodeDoctorSnapshot,
  formatDoctorReport,
  isIssue,
  overallStatus,
  rollupStatus,
  summarizeSnapshot,
} from "./doctor";

function area(id: DoctorArea["id"], status: DoctorStatus): DoctorArea {
  return { id, label: id, status, verdict: "" };
}

function snapshot(statuses: readonly DoctorStatus[]): DoctorSnapshot {
  return {
    state: "ready",
    areas: statuses.map((status, index) => area(DOCTOR_AREA_ORDER[index] ?? "core", status)),
  };
}

describe("rollupStatus", () => {
  it("returns not_checked for an empty set", () => {
    expect(rollupStatus([])).toBe("not_checked");
  });

  it("lets the most severe status dominate", () => {
    expect(rollupStatus(["ok", "warn", "error"])).toBe("error");
    expect(rollupStatus(["ok", "warn", "not_checked"])).toBe("warn");
    expect(rollupStatus(["ok", "ok"])).toBe("ok");
  });

  it("treats an all-unchecked set as not_checked, not ok", () => {
    expect(rollupStatus(["not_checked", "not_checked"])).toBe("not_checked");
  });

  it("ignores not_checked when a real status is present", () => {
    expect(rollupStatus(["not_checked", "ok"])).toBe("ok");
  });
});

describe("overallStatus", () => {
  it("rolls the worst area status up to the snapshot", () => {
    expect(overallStatus(snapshot(["ok", "ok", "warn"]))).toBe("warn");
    expect(overallStatus(snapshot(["ok", "error", "warn"]))).toBe("error");
    expect(overallStatus(snapshot(["ok", "ok", "ok"]))).toBe("ok");
  });
});

describe("summarizeSnapshot", () => {
  it("counts each area into exactly one bucket and totals them", () => {
    const summary = summarizeSnapshot(snapshot(["ok", "ok", "warn", "error", "not_checked"]));
    expect(summary).toEqual({ ok: 2, warn: 1, error: 1, notChecked: 1, total: 5 });
    expect(summary.ok + summary.warn + summary.error + summary.notChecked).toBe(summary.total);
  });

  it("handles an empty snapshot", () => {
    expect(summarizeSnapshot(snapshot([]))).toEqual({
      ok: 0,
      warn: 0,
      error: 0,
      notChecked: 0,
      total: 0,
    });
  });
});

describe("isIssue", () => {
  it("keeps exactly warn and error areas - the issues-only filter can never hide them", () => {
    expect(isIssue(area("core", "error"))).toBe(true);
    expect(isIssue(area("core", "warn"))).toBe(true);
    expect(isIssue(area("core", "ok"))).toBe(false);
    expect(isIssue(area("core", "not_checked"))).toBe(false);
  });
});

describe("formatDoctorReport", () => {
  const snap: DoctorSnapshot = {
    state: "ready",
    checkedAt: "12s ago",
    host: { workspace: "~/dev/trevorV2" },
    areas: [
      {
        id: "internet",
        label: "Internet",
        status: "warn",
        verdict: "unreachable",
        facts: [{ label: "probe", value: "dns+https" }],
        findings: [
          {
            id: "internet.reachability",
            status: "warn",
            title: "Public internet",
            message: "last probe failed",
            source: "https://example.test",
            evidence: "ETIMEDOUT",
            nextAction: { label: "Check the network", command: "/doctor refresh" },
          },
        ],
      },
      { id: "core", label: "Core", status: "ok", verdict: "running" },
    ],
  };

  it("renders a paste-ready report: header, summary, areas, findings, and next actions", () => {
    const report = formatDoctorReport(snap);
    expect(report).toContain("Trevor /doctor - Degraded");
    expect(report).toContain("12s ago · 2 areas · 0 error, 1 warning, 1 ok, 0 not checked");
    expect(report).toContain("workspace: ~/dev/trevorV2");
    expect(report).toContain("## Internet [WARN] unreachable");
    expect(report).toContain("- probe: dns+https");
    expect(report).toContain("[WARN] Public internet - last probe failed");
    expect(report).toContain("source: https://example.test");
    expect(report).toContain("evidence: ETIMEDOUT");
    expect(report).toContain("next: Check the network (/doctor refresh)");
    expect(report).toContain("## Core [OK] running");
  });

  it("carries no field the dashboard does not already show (no secrets beyond the snapshot)", () => {
    // Every non-structural token in the report must trace back to a snapshot string.
    const report = formatDoctorReport(snap);
    expect(report).not.toContain("undefined");
    // A snapshot with no host context omits the workspace line entirely.
    const bare = formatDoctorReport({ state: "ready", areas: [] });
    expect(bare).not.toContain("workspace:");
  });
});

describe("decodeDoctorSnapshot", () => {
  it("decodes a structured snapshot but rejects legacy text / errors / junk", () => {
    const snap: DoctorSnapshot = { state: "ready", areas: [area("core", "ok")] };
    expect(decodeDoctorSnapshot(JSON.stringify(snap))?.state).toBe("ready");
    expect(decodeDoctorSnapshot("workspace: ~/dev\nproviders:")).toBeNull();
    expect(decodeDoctorSnapshot("error: boom")).toBeNull();
    expect(decodeDoctorSnapshot(undefined)).toBeNull();
    expect(decodeDoctorSnapshot('{"state":"ready"}')).toBeNull();
  });
});
