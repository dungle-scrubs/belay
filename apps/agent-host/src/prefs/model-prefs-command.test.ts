import type { TrevorEventInput } from "@belay/session";
import { describe, expect, test } from "vitest";
import {
  applyModelPrefsCommand,
  decodeModelPrefsArg,
  MODEL_DEFAULT_COMMAND,
  MODEL_FAVORITE_COMMAND,
  runModelPrefsCommand,
} from "./model-prefs-command";
import type { ModelPrefsFile } from "./model-prefs-store";

/**
 * M3 (plan 51): the set-default / toggle-favorite host command. The pure apply reuses the @belay/session
 * transitions over the persisted `{ default, pinned }` subset; the runner decodes the JSON ref, applies +
 * persists + re-announces on success, and rejects a malformed ref without touching the store. A tiny fake
 * store + event sink stand in for disk + transport.
 */

const REF = { sourceId: "zai", modelId: "glm-5.2", reasoning: "high" as const };
const OTHER = { sourceId: "lmstudio", modelId: "qwen3-30b", reasoning: null };
const EMPTY: ModelPrefsFile = { default: null, pinned: [] };

describe("decodeModelPrefsArg", () => {
  test("decodes a JSON ModelRef; rejects non-JSON and a ref with no source/model id", () => {
    expect(decodeModelPrefsArg(JSON.stringify(REF))).toEqual(REF);
    expect(decodeModelPrefsArg("not json")).toBeNull();
    expect(decodeModelPrefsArg(JSON.stringify({ sourceId: "x" }))).toBeNull();
  });
});

describe("applyModelPrefsCommand (pure)", () => {
  test("set-default replaces the default and leaves favorites untouched", () => {
    const next = applyModelPrefsCommand(
      { default: OTHER, pinned: [OTHER] },
      MODEL_DEFAULT_COMMAND,
      REF,
    );
    expect(next).toEqual({ default: REF, pinned: [OTHER] });
  });

  test("toggle-favorite adds when absent and removes when present (idempotent within a toggle)", () => {
    const added = applyModelPrefsCommand(EMPTY, MODEL_FAVORITE_COMMAND, REF);
    expect(added).toEqual({ default: null, pinned: [REF] });
    const removed = applyModelPrefsCommand(added, MODEL_FAVORITE_COMMAND, REF);
    expect(removed).toEqual({ default: null, pinned: [] });
  });
});

/** A fake store + sink capturing writes, results, and re-announces. */
function harness(initial: ModelPrefsFile = EMPTY) {
  let stored = initial;
  const results: TrevorEventInput[] = [];
  let announces = 0;
  const deps = {
    load: () => stored,
    save: (next: ModelPrefsFile) => {
      stored = next;
    },
    emit: (event: TrevorEventInput) => {
      results.push(event);
    },
    announce: () => {
      announces += 1;
    },
  };
  return { deps, get: () => stored, results, announces: () => announces };
}

describe("runModelPrefsCommand", () => {
  test("set-default persists the default, returns an ok result, and re-announces", async () => {
    const h = harness();
    const ok = await runModelPrefsCommand(h.deps, MODEL_DEFAULT_COMMAND, JSON.stringify(REF));
    expect(ok).toBe(true);
    expect(h.get().default).toEqual(REF);
    expect(h.announces()).toBe(1);
    const result = h.results.at(-1);
    expect(result?.type).toBe("command.result");
    expect((result?.payload as { ok: boolean })?.ok).toBe(true);
  });

  test("adding a favorite persists it; a second toggle persists the removal (each re-announces)", async () => {
    const h = harness();
    await runModelPrefsCommand(h.deps, MODEL_FAVORITE_COMMAND, JSON.stringify(REF));
    expect(h.get().pinned).toEqual([REF]);
    await runModelPrefsCommand(h.deps, MODEL_FAVORITE_COMMAND, JSON.stringify(REF));
    expect(h.get().pinned).toEqual([]);
    expect(h.announces()).toBe(2);
  });

  test("an unusable ref is rejected: ok:false result, no write, no re-announce (store uncorrupted)", async () => {
    const h = harness({ default: OTHER, pinned: [OTHER] });
    const ok = await runModelPrefsCommand(h.deps, MODEL_DEFAULT_COMMAND, "not-json");
    expect(ok).toBe(false);
    // The store is untouched.
    expect(h.get()).toEqual({ default: OTHER, pinned: [OTHER] });
    expect(h.announces()).toBe(0);
    const result = h.results.at(-1);
    expect((result?.payload as { ok: boolean })?.ok).toBe(false);
  });
});
