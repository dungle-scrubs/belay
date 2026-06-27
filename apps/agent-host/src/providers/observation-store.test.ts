import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildObservation,
  fingerprintObservation,
  type ObservationInput,
  observationsPath,
  readObservations,
  recordObservation,
  summarizeObservations,
} from "./observation-store";

/**
 * D-076 M5: the redacted, deduped provider-observation store. Pins the TREVOR_HOME override, stable
 * fingerprinting (transient values collapse so repeats dedupe), dedupe with first/last-seen + count,
 * best-effort write failure (never throws), redaction (no key/token/header/body in the record), and
 * the /doctor summary shape.
 */

const NOW = "2026-06-27T12:00:00.000Z";
let home: string;
const savedHome = process.env.TREVOR_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "trevor-obs-"));
  process.env.TREVOR_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) {
    delete process.env.TREVOR_HOME;
  } else {
    process.env.TREVOR_HOME = savedHome;
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

describe("observationsPath", () => {
  it("resolves under the runtime TREVOR_HOME override", () => {
    expect(observationsPath()).toBe(join(home, "provider-observations.json"));
  });
});

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
  it("writes a fresh record with count 1 and first/last seen", async () => {
    const rec = await recordObservation(input(), NOW);
    expect(rec?.count).toBe(1);
    expect(rec?.firstSeen).toBe(NOW);
    expect(rec?.lastSeen).toBe(NOW);
    const store = await readObservations();
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("dedupes repeats by fingerprint: count climbs, firstSeen holds, lastSeen advances", async () => {
    await recordObservation(input({ message: "ECONNREFUSED 127.0.0.1:1234" }), NOW);
    const later = "2026-06-27T12:05:00.000Z";
    const rec = await recordObservation(input({ message: "ECONNREFUSED 10.0.0.9:9999" }), later);
    expect(rec?.count).toBe(2);
    expect(rec?.firstSeen).toBe(NOW);
    expect(rec?.lastSeen).toBe(later);
    const store = await readObservations();
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("never stores secrets - keys, tokens, headers, or raw bodies are redacted", async () => {
    await recordObservation(
      input({
        message: "Authorization: Bearer sk-ant-SUPERSECRET01234 failed; api_key=pi-TOPSECRET99",
      }),
      NOW,
    );
    const onDisk = readFileSync(observationsPath(), "utf8");
    expect(onDisk).not.toContain("sk-ant-SUPERSECRET01234");
    expect(onDisk).not.toContain("pi-TOPSECRET99");
    expect(onDisk).toContain("«redacted»");
  });

  it("stores field NAMES only, never raw payload values", async () => {
    await recordObservation(input({ shapeFields: ["error", "headers", "request"] }), NOW);
    const store = await readObservations();
    const rec = Object.values(store)[0];
    expect(rec?.shapeFields).toEqual(["error", "headers", "request"]);
  });

  it("is best-effort: a write failure returns null and does not throw", async () => {
    // Point TREVOR_HOME at a path whose parent is a FILE, so mkdir/write fails.
    const filePath = join(home, "not-a-dir");
    writeFileSync(filePath, "x");
    process.env.TREVOR_HOME = join(filePath, "nested");
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

describe("buildObservation", () => {
  it("re-redacts the message even when the caller forgot to sanitize", () => {
    const rec = buildObservation(input({ message: "token=sk-leakyleakyleaky00" }), NOW);
    expect(rec.message).not.toContain("sk-leakyleakyleaky00");
  });
});
