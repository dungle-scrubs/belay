import { describe, expect, it } from "vitest";
import {
  DOCTOR_AREA_ORDER,
  type DoctorArea,
  type DoctorSnapshot,
  type DoctorStatus,
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
