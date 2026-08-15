import { storagePathByName } from "@belay/session/node-paths";
import { USER_MODEL_PREFS_JSON } from "@host/boot/paths";
import { describe, expect, test } from "vitest";
import {
  EMPTY_MODEL_PREFS,
  loadModelPrefs,
  type ModelPrefsFile,
  modelPrefs,
  parseModelPrefs,
  saveModelPrefs,
  toModelPreferences,
} from "./model-prefs-store";

/**
 * M1 (plan 51): the host-owned model-selection preference store. It reads a `{ default, pinned }` JSON
 * from `model-prefs.json` under the config home, tolerating a missing/malformed file (both -> the empty
 * preference, reported not thrown) so a bad file never blocks host startup. It reuses the pure
 * @belay/session decoder + transitions rather than re-implementing default/pin logic. Read/write are
 * injected (no disk); the cached accessor's injected read lets the cache-clear-on-save be observed.
 */

const REF = { sourceId: "zai", modelId: "glm-5.2", reasoning: "high" as const };
const PIN = { sourceId: "lmstudio", modelId: "qwen3-30b", reasoning: null };

describe("parseModelPrefs", () => {
  test("a well-formed file round-trips a default + pinned list", () => {
    const prefs = parseModelPrefs({ default: REF, pinned: [PIN] });
    expect(prefs).toEqual({ default: REF, pinned: [PIN] });
  });

  test("a missing/garbled default or favorite drops to a safe value (never throws)", () => {
    // A partial ref (no modelId) decodes to null; a garbled favorite is filtered out.
    expect(
      parseModelPrefs({ default: { sourceId: "x" }, pinned: [{ modelId: "y" }, PIN] }),
    ).toEqual({ default: null, pinned: [PIN] });
    expect(parseModelPrefs(null)).toEqual(EMPTY_MODEL_PREFS);
    expect(parseModelPrefs(42)).toEqual(EMPTY_MODEL_PREFS);
  });
});

describe("loadModelPrefs", () => {
  test("reads a persisted default + favorites from the config file (path is injectable)", () => {
    const prefs = loadModelPrefs("/home/.belay/model-prefs.json", () =>
      JSON.stringify({ default: REF, pinned: [PIN] }),
    );
    expect(prefs).toEqual({ default: REF, pinned: [PIN] });
  });

  test("a missing file yields the empty preference, silently", () => {
    const prefs = loadModelPrefs("/x/model-prefs.json", () => {
      throw new Error("ENOENT");
    });
    expect(prefs).toEqual(EMPTY_MODEL_PREFS);
  });

  test("a malformed file falls back to the empty preference rather than throwing", () => {
    expect(() => loadModelPrefs("/x/model-prefs.json", () => "{ not json")).not.toThrow();
    expect(loadModelPrefs("/x/model-prefs.json", () => "{ not json")).toEqual(EMPTY_MODEL_PREFS);
  });
});

describe("saveModelPrefs", () => {
  test("writes a minimal { default, pinned } JSON to the config path", () => {
    const files = new Map<string, string>();
    saveModelPrefs(
      { default: REF, pinned: [PIN] },
      "/home/.belay/model-prefs.json",
      (p, c) => void files.set(p, c),
    );
    const written = files.get("/home/.belay/model-prefs.json");
    expect(written).toBeDefined();
    expect(JSON.parse(written ?? "")).toEqual({ default: REF, pinned: [PIN] });
  });
});

describe("toModelPreferences", () => {
  test("lifts the persisted subset into full pure preferences (empty active/recent/reasoning)", () => {
    const full = toModelPreferences({ default: REF, pinned: [PIN] });
    expect(full.default).toEqual(REF);
    expect(full.pinned).toEqual([PIN]);
    expect(full.active).toBeNull();
    expect(full.recent).toEqual([]);
    expect(full.reasoningByModel).toEqual({});
  });
});

describe("USER_MODEL_PREFS_JSON path", () => {
  test("resolves under BELAY_HOME via the storage inventory (config, not state)", () => {
    // The host constant and the inventory-resolved path are the same file, so the drift guard's
    // single-owner literal and the store's real target can never diverge.
    expect(USER_MODEL_PREFS_JSON).toBe(storagePathByName("model-prefs"));
    expect(USER_MODEL_PREFS_JSON.endsWith("/model-prefs.json")).toBe(true);
  });
});

describe("modelPrefs cache", () => {
  test("saveModelPrefs clears the read-once cache so the next read reflects the change", () => {
    const path = "/x/model-prefs.json";
    // Clear any cache a sibling test populated (from the real disk path -> empty on the test box).
    saveModelPrefs(EMPTY_MODEL_PREFS, path, () => {});

    let reads = 0;
    const read = (): string => {
      reads += 1;
      return JSON.stringify({ default: REF, pinned: [] } satisfies ModelPrefsFile);
    };

    const first = modelPrefs(read);
    expect(first.default).toEqual(REF);
    expect(reads).toBe(1);

    // A second read is served from the cache - no re-read.
    modelPrefs(read);
    expect(reads).toBe(1);

    // Persisting clears the cache, so the following read hits `read` again.
    saveModelPrefs({ default: PIN, pinned: [] }, path, () => {});
    modelPrefs(read);
    expect(reads).toBe(2);
  });
});
