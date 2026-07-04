import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ObservationInput } from "./failure-record-schema";
import { corpusJsonlPath } from "./observation-corpus";
import {
  fingerprintObservation,
  readObservations,
  recordObservation,
  summarizeObservations,
} from "./observation-store";

/**
 * The producer-facing corpus façade (plan 29). Pins the state-home corpus location, stable
 * fingerprinting (transient values collapse so repeats dedupe), dedupe with first/last-seen + count,
 * best-effort write failure (never throws), redaction (no key/token/header/body in the record), the
 * /doctor summary shape, and the one-time migration of the legacy single-file store.
 */

const NOW = "2026-06-27T12:00:00.000Z";
let home: string;
const savedHome = process.env.TREVOR_STATE_HOME;
const savedConfig = process.env.TREVOR_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "trevor-obs-"));
  process.env.TREVOR_STATE_HOME = home;
  // Isolate the config home too, so migration never sees the developer's real ~/.trevorV2.
  process.env.TREVOR_HOME = join(home, "config");
});

afterEach(() => {
  for (const [key, value] of [
    ["TREVOR_STATE_HOME", savedHome],
    ["TREVOR_HOME", savedConfig],
  ] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  rmSync(home, { recursive: true, force: true });
});

function input(over: Partial<ObservationInput> = {}): ObservationInput {
  return {
    provider: "gpt",
    model: "gpt-5.5",
    authMode: "oauth",
    phase: "model-step",
    classification: "unknown",
    retryable: false,
    message: "some never-before-seen provider error 12345",
    shapeFields: ["error", "status"],
    outputStarted: false,
    ...over,
  };
}

describe("fingerprintObservation", () => {
  it("is stable across transient values (addresses, ids, digits collapse)", () => {
    const a = fingerprintObservation(input({ message: "ECONNREFUSED 127.0.0.1:1234 reqid 9f3a" }));
    const b = fingerprintObservation(input({ message: "ECONNREFUSED 10.0.0.2:5678 reqid 7b1c" }));
    expect(a).toBe(b);
  });

  it("differs when the shape differs (class, status, or message skeleton)", () => {
    const base = fingerprintObservation(input());
    expect(fingerprintObservation(input({ classification: "rate_limited" }))).not.toBe(base);
    expect(fingerprintObservation(input({ status: 503 }))).not.toBe(base);
    expect(fingerprintObservation(input({ message: "a totally different failure" }))).not.toBe(
      base,
    );
  });
});

describe("recordObservation", () => {
  it("writes a fresh record with count 1 and first/last seen under the state corpus", async () => {
    const rec = await recordObservation(input(), NOW);
    expect(rec?.count).toBe(1);
    expect(rec?.firstSeen).toBe(NOW);
    expect(rec?.lastSeen).toBe(NOW);
    expect(rec?.kind).toBe("provider_failure");
    expect(existsSync(corpusJsonlPath("provider_failure"))).toBe(true);
    expect(Object.keys(await readObservations())).toHaveLength(1);
  });

  it("dedupes repeats by fingerprint: count climbs, firstSeen holds, lastSeen advances", async () => {
    await recordObservation(input({ message: "ECONNREFUSED 127.0.0.1:1234" }), NOW);
    const later = "2026-06-27T12:05:00.000Z";
    const rec = await recordObservation(input({ message: "ECONNREFUSED 10.0.0.9:9999" }), later);
    expect(rec?.count).toBe(2);
    expect(rec?.firstSeen).toBe(NOW);
    expect(rec?.lastSeen).toBe(later);
    expect(Object.keys(await readObservations())).toHaveLength(1);
  });

  it("never stores secrets - keys, tokens, headers, or raw bodies are redacted", async () => {
    await recordObservation(
      input({
        message: "Authorization: Bearer sk-ant-SUPERSECRET01234 failed; api_key=pi-TOPSECRET99",
      }),
      NOW,
    );
    const onDisk = readFileSync(corpusJsonlPath("provider_failure"), "utf8");
    expect(onDisk).not.toContain("sk-ant-SUPERSECRET01234");
    expect(onDisk).not.toContain("pi-TOPSECRET99");
    expect(onDisk).toContain("«redacted»");
  });

  it("stores field NAMES only, never raw payload values", async () => {
    await recordObservation(input({ shapeFields: ["error", "headers", "request"] }), NOW);
    const rec = Object.values(await readObservations())[0];
    expect(rec?.shape.fieldNames).toEqual(["error", "headers", "request"]);
  });

  it("is best-effort: a write failure returns null and does not throw", async () => {
    // Point TREVOR_STATE_HOME at a path whose parent is a FILE, so mkdir/write fails.
    const filePath = join(home, "not-a-dir");
    writeFileSync(filePath, "x");
    process.env.TREVOR_STATE_HOME = join(filePath, "nested");
    const rec = await recordObservation(input(), NOW);
    expect(rec).toBeNull();
  });
});

describe("summarizeObservations", () => {
  it("counts distinct shapes, total sightings, unknown sightings, and the top fingerprints", async () => {
    await recordObservation(input({ message: "shape A" }), NOW);
    await recordObservation(input({ message: "shape A" }), NOW);
    await recordObservation(input({ message: "shape B", classification: "rate_limited" }), NOW);
    const summary = summarizeObservations(await readObservations());
    expect(summary.distinct).toBe(2);
    expect(summary.total).toBe(3);
    expect(summary.unknown).toBe(2);
    expect(summary.top[0]?.count).toBe(2);
  });
});

describe("legacy migration (M1/M9)", () => {
  it("imports a pre-corpus single-file store, preserving fingerprint + count, and tombstones it", async () => {
    // Seed the old state-home single file the pre-corpus store wrote.
    const fp = fingerprintObservation(input());
    const legacyPath = join(home, "provider-observations.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        [fp]: {
          fingerprint: fp,
          provider: "gpt",
          model: "gpt-5.5",
          authMode: "oauth",
          phase: "model-step",
          classification: "unknown",
          retryable: false,
          message: "some never-before-seen provider error 12345",
          shapeFields: ["error", "status"],
          outputStarted: false,
          firstSeen: "2026-06-01T00:00:00.000Z",
          lastSeen: "2026-06-02T00:00:00.000Z",
          count: 7,
        },
      }),
      "utf8",
    );

    const index = await readObservations();
    const rec = index[fp];
    expect(rec?.count).toBe(7);
    expect(rec?.firstSeen).toBe("2026-06-01T00:00:00.000Z");
    expect(rec?.lastSeen).toBe("2026-06-02T00:00:00.000Z");
    expect(rec?.shape.classification).toBe("unknown");

    // The legacy file is tombstoned (preserved, not re-imported on the next read).
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(join(home, "provider-observations.migrated.json"))).toBe(true);

    // A subsequent record does not double-import the legacy data.
    await recordObservation(input({ message: "a brand new shape" }), NOW);
    const after = await readObservations();
    expect(after[fp]?.count).toBe(7);
  });
});
