import assert from "node:assert/strict";
import { type DoctorSnapshot, formatDoctorReport } from "@trevor/session";
import { doctorArea, doctorSnapshot } from "@trevor/test-kit";
import { Effect } from "effect";
import { test } from "vitest";
import { registerDoctorSnapshotSource } from "../doctor/source";
import { doctorTool } from "./doctor";
import { executeTool } from "./index";

/**
 * The `doctor` model tool (D-073 M6): a read-only drill-in that returns Trevor's OWN host health
 * report. It draws from the registered snapshot source (the host wires it in main.ts; here a test
 * source stands in), renders the sanitized plaintext report the model reads, and degrades a source
 * failure to one clean `error:` line instead of collapsing the turn.
 */

const SNAPSHOT: DoctorSnapshot = doctorSnapshot({
  checkedAt: "just now",
  host: { workspace: "~/dev/trevorV2", instanceId: "abcd1234", role: "leader" },
  areas: [
    doctorArea("core", "ok", {
      label: "Core",
      verdict: "running as leader",
      findings: [
        { id: "core.process", status: "ok", title: "Host process", message: "running as leader" },
      ],
    }),
    doctorArea("internet", "warn", {
      label: "Internet",
      verdict: "offline",
      facts: [{ label: "detail", value: "DNS lookup failed", status: "warn" }],
    }),
  ],
});

test("the doctor tool is read-only and named 'doctor'", () => {
  assert.equal(doctorTool.name, "doctor");
  assert.equal(doctorTool.readOnly, true);
});

test("doctor returns the formatted health report from the registered snapshot source", async () => {
  registerDoctorSnapshotSource(async () => SNAPSHOT);
  const result = await Effect.runPromise(executeTool("doctor", "{}"));
  // The model reads the sanitized plaintext report, not the raw JSON struct.
  assert.equal(result, formatDoctorReport(SNAPSHOT));
  assert.ok(result.includes("Trevor /doctor - Degraded"), "the report headline reflects the warn");
  assert.ok(result.includes("Host process"), "an area finding is rendered");
});

test("doctor takes no arguments (empty payload decodes and runs)", async () => {
  registerDoctorSnapshotSource(async () => SNAPSHOT);
  // executeTool defaults a missing payload to {}, so the no-arg call still resolves.
  const result = await Effect.runPromise(executeTool("doctor", ""));
  assert.equal(result, formatDoctorReport(SNAPSHOT));
});

test("a snapshot-source failure degrades to one clean error line, not a thrown turn", async () => {
  registerDoctorSnapshotSource(async () => {
    throw new Error("host is not the live leader");
  });
  const result = await Effect.runPromise(executeTool("doctor", "{}"));
  assert.match(result, /^error: doctor failed - /);
  assert.ok(result.includes("host is not the live leader"), "the sanitized cause is surfaced");
});
