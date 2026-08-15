import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@belay/test-kit";
import { type BootedBlob, bootBlob } from "@belay/test-kit/boot";
import { afterEach, test } from "vitest";

/**
 * Hermetic telemetry e2e (plan 13 M13). With the local file exporter, a REAL booted blob-store writes
 * bounded, redacted JSONL telemetry through an actual HTTP round-trip; with telemetry disabled (the
 * default) it writes NOTHING and nothing leaves the machine. No DSN, no network, no collector - so it
 * runs in the required hermetic e2e lane.
 */

const saved: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in saved)) {
      saved[key] = process.env[key];
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
function restoreEnv(): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
    delete saved[key];
  }
}

let blob: BootedBlob | null = null;
let stateHome: string | null = null;

afterEach(async () => {
  if (blob) {
    await blob.close();
    blob = null;
  }
  if (stateHome) {
    rmSync(stateHome, { recursive: true, force: true });
    stateHome = null;
  }
  restoreEnv();
});

async function put(body: string): Promise<void> {
  await fetch(`${blob?.url}/blobs`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body,
  });
}

test("the file exporter writes bounded blob-store telemetry through a real HTTP round-trip", async () => {
  stateHome = tempDir("belay-telem-e2e-");
  setEnv({ BELAY_STATE_HOME: stateHome, TREVOR_OTEL_EXPORTER: "file" });
  blob = await bootBlob();
  await put("secret telemetry e2e blob body");

  const file = join(stateHome, "otel", "blob-store.jsonl");
  assert.ok(existsSync(file), "the file exporter wrote a telemetry artifact");
  const raw = readFileSync(file, "utf8");
  const records = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    records.some((r) => r.t === "span" && r.name === "belay.blob.io"),
    "a blob-IO span was exported to the file",
  );
  assert.ok(
    !raw.includes("secret telemetry e2e blob body"),
    "the blob body never enters telemetry",
  );
});

test("with telemetry disabled (the default), a booted service writes no otel artifacts", async () => {
  stateHome = tempDir("belay-telem-e2e-");
  setEnv({
    BELAY_STATE_HOME: stateHome,
    TREVOR_OTEL_EXPORTER: undefined,
    TREVOR_SENTRY_DSN: undefined,
  });
  blob = await bootBlob();
  await put("no telemetry here");

  assert.equal(
    existsSync(join(stateHome, "otel")),
    false,
    "nothing is written when telemetry is off (no outbound, no local artifact)",
  );
});
