import assert from "node:assert/strict";
import type { DoctorSnapshot } from "@belay/session";
import { doctorArea, doctorSnapshot } from "@belay/test-kit";
import { render } from "@testing-library/react";
import { test } from "vitest";
import { DoctorResult } from "./doctor-result";

/**
 * D-073 M5: the /doctor result wiring. A structured doctor.current snapshot renders the dashboard;
 * a legacy `/doctor text` dump (or an error) falls back to the plain command-result row.
 */

const SNAPSHOT: DoctorSnapshot = doctorSnapshot({
  checkedAt: "just now",
  areas: [
    doctorArea("internet", "warn", {
      label: "Internet",
      verdict: "unreachable",
      findings: [
        {
          id: "internet.reachability",
          status: "warn",
          title: "Public internet",
          message: "unreachable",
        },
      ],
    }),
    doctorArea("core", "ok", {
      label: "Core",
      verdict: "running",
      findings: [{ id: "core.process", status: "ok", title: "Host process", message: "running" }],
    }),
  ],
});

test("a structured snapshot renders the dashboard, not raw JSON", () => {
  const { container } = render(
    <DoctorResult command="/doctor" text={JSON.stringify(SNAPSHOT)} ok />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("Internet"), "an area label renders");
  assert.ok(text.includes("Public internet"), "a finding renders");
  assert.ok(!text.includes('"state"'), "the raw JSON is not shown");
});

test("a legacy text dump falls back to the plain command-result row", () => {
  const { container } = render(
    <DoctorResult
      command="/doctor"
      text={"workspace: ~/dev/belay\nproviders:\n  qwen - warm"}
      ok
    />,
  );
  assert.ok(
    (container.textContent ?? "").includes("workspace: ~/dev/belay"),
    "the text dump shows verbatim",
  );
});

test("an error result falls back to the command-result row", () => {
  const { container } = render(
    <DoctorResult command="/doctor" text="error: doctor failed" ok={false} />,
  );
  assert.ok((container.textContent ?? "").includes("doctor failed"));
});
