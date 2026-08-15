import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ObservationInput } from "./failure-record-schema";
import {
  appendObservation,
  corpusIndexPath,
  corpusJsonlPath,
  deleteByFingerprint,
  deleteByKind,
  deleteCorpus,
  exportCorpus,
  readCorpusIndex,
  rebuildCorpusIndex,
} from "./observation-corpus";
import {
  loopPatternEnvelope,
  type ObservationEnvelope,
  providerFailureEnvelope,
} from "./observation-envelope";

/**
 * M1 (paths) + M3 (append/dedupe/index/repair) + M5 (export/delete). Append-only JSONL with a deduped
 * index folded over it, best-effort writes, corrupt-index tolerance via a JSONL rebuild, and the
 * export/delete control paths.
 */

const NOW = "2026-06-27T12:00:00.000Z";
let home: string;
const savedHome = process.env.BELAY_STATE_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "belay-corpus-"));
  process.env.BELAY_STATE_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) {
    delete process.env.BELAY_STATE_HOME;
  } else {
    process.env.BELAY_STATE_HOME = savedHome;
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

describe("corpus paths (M1)", () => {
  it("resolves the jsonl and index under BELAY_STATE_HOME/observations", () => {
    expect(corpusJsonlPath("provider_failure")).toBe(
      join(home, "observations", "provider-failures.jsonl"),
    );
    expect(corpusIndexPath()).toBe(join(home, "observations", "index.json"));
  });
});

describe("append + dedupe (M3)", () => {
  it("appends one JSONL line per sighting and folds a deduped index entry", async () => {
    await appendObservation(providerFailureEnvelope(input(), NOW));
    const later = "2026-06-27T12:05:00.000Z";
    const merged = await appendObservation(
      providerFailureEnvelope(
        input({ message: "some never-before-seen provider error 99999" }),
        later,
      ),
    );
    expect(merged?.count).toBe(2);
    expect(merged?.firstSeen).toBe(NOW);
    expect(merged?.lastSeen).toBe(later);

    // JSONL is append-only: one line per sighting.
    const jsonl = await readFile(corpusJsonlPath("provider_failure"), "utf8");
    expect(jsonl.trim().split("\n")).toHaveLength(2);

    // Index is deduped by fingerprint.
    const index = await readCorpusIndex();
    expect(Object.keys(index)).toHaveLength(1);
  });

  it("keeps distinct shapes as distinct index entries", async () => {
    await appendObservation(providerFailureEnvelope(input(), NOW));
    await appendObservation(providerFailureEnvelope(input({ status: 503 }), NOW));
    const index = await readCorpusIndex();
    expect(Object.keys(index)).toHaveLength(2);
  });
});

describe("best-effort + repair (M3)", () => {
  it("rebuilds the index from JSONL when index.json is corrupt", async () => {
    await appendObservation(providerFailureEnvelope(input(), NOW));
    await appendObservation(providerFailureEnvelope(input(), NOW));
    // Corrupt the index; the JSONL (source of truth) still holds both sightings.
    writeFileSync(corpusIndexPath(), "}{ not json");
    const repaired = await rebuildCorpusIndex();
    const rec = Object.values(repaired)[0];
    expect(rec?.count).toBe(2);
    // The repaired index is persisted and re-readable.
    const reread = await readCorpusIndex();
    expect(Object.values(reread)[0]?.count).toBe(2);
  });

  it("tolerates corrupt JSONL lines: valid sightings still aggregate", async () => {
    await appendObservation(providerFailureEnvelope(input(), NOW));
    const path = corpusJsonlPath("provider_failure");
    writeFileSync(path, `${readFileSync(path, "utf8")}this is not json\n`, "utf8");
    const repaired = await rebuildCorpusIndex();
    expect(Object.values(repaired)[0]?.count).toBe(1);
  });

  it("survives concurrent appends: every sighting lands in the JSONL and rebuild counts them", async () => {
    const writes = Array.from({ length: 12 }, () =>
      appendObservation(providerFailureEnvelope(input(), NOW)),
    );
    await Promise.all(writes);
    const jsonl = await readFile(corpusJsonlPath("provider_failure"), "utf8");
    expect(jsonl.trim().split("\n")).toHaveLength(12);
    const repaired = await rebuildCorpusIndex();
    expect(Object.values(repaired)[0]?.count).toBe(12);
  });
});

describe("export + delete (M5)", () => {
  it("exports the deduped redacted records with no raw secret", async () => {
    await appendObservation(
      providerFailureEnvelope(
        input({ message: "Authorization: Bearer sk-ant-EXPORTLEAK0001 blew up" }),
        NOW,
      ),
    );
    const records = await exportCorpus();
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain("sk-ant-EXPORTLEAK0001");
  });

  it("deletes the whole corpus", async () => {
    await appendObservation(providerFailureEnvelope(input(), NOW));
    await deleteCorpus();
    expect(await readCorpusIndex()).toEqual({});
    expect(await exportCorpus()).toEqual([]);
  });

  it("deletes a single fingerprint, leaving the rest", async () => {
    const a = await appendObservation(providerFailureEnvelope(input(), NOW));
    await appendObservation(providerFailureEnvelope(input({ status: 503 }), NOW));
    const removed = await deleteByFingerprint(a?.fingerprint ?? "");
    expect(removed).toBe(true);
    const index = await readCorpusIndex();
    expect(Object.keys(index)).toHaveLength(1);
    expect(index[a?.fingerprint ?? ""]).toBeUndefined();
  });

  it("deletes by kind, dropping that kind's JSONL and index entries", async () => {
    await appendObservation(providerFailureEnvelope(input(), NOW));
    await appendObservation(loopPatternEnvelope({ pattern: "stall", phase: "loop" }, NOW));
    await deleteByKind("provider_failure");
    const records = await exportCorpus();
    expect(records.every((r: ObservationEnvelope) => r.kind === "loop_pattern")).toBe(true);
  });
});
