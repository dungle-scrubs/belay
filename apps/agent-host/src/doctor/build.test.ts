import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { afterEach, beforeEach, test } from "vitest";
import type { ProviderRegistry } from "../providers";
import { collectDoctorProbeResults } from "./build";

/**
 * Plan 41 M4: `/doctor` provider probing is BOUNDED and NON-MUTATING. These drive the real command
 * probe path (`collectDoctorProbeResults`) - not the standalone runner - and pin two guarantees:
 *  1. a wedged provider readiness degrades to `unreachable` within the injected timeout instead of
 *     hanging the whole command, and
 *  2. a health probe only reads `readiness()`; it never warms, loads, or streams a model, so running
 *     /doctor can never change provider/model state.
 */

let stateHome: string;
const savedStateHome = process.env.TREVOR_STATE_HOME;

beforeEach(() => {
  stateHome = mkdtempSync(join(tmpdir(), "trevor-doctor-build-"));
  process.env.TREVOR_STATE_HOME = stateHome;
});

afterEach(() => {
  if (savedStateHome === undefined) {
    delete process.env.TREVOR_STATE_HOME;
  } else {
    process.env.TREVOR_STATE_HOME = savedStateHome;
  }
  rmSync(stateHome, { recursive: true, force: true });
});

/** A provider whose readiness is `readiness`, and whose mutating surfaces (`warm`, `stream`) throw if
 *  a health probe ever touches them - so a call proves /doctor mutated provider state. */
function provider(over: {
  readonly kind: "local" | "cloud";
  readonly readiness: () => ReturnType<ProviderRegistry[string]["readiness"]>;
  readonly onMutate: () => void;
}): ProviderRegistry[string] {
  return {
    id: "p",
    label: "P",
    model: "m",
    reasoningLevels: [],
    defaultReasoning: "off",
    kind: over.kind,
    describe: () => ({
      label: "P",
      model: "m",
      reasoningLevels: [],
      defaultReasoning: "off",
      kind: over.kind,
    }),
    readiness: over.readiness,
    capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 8192 }),
    warm: () => {
      over.onMutate();
      return Effect.void;
    },
    stream: () => {
      over.onMutate();
      return Stream.empty;
    },
  } as unknown as ProviderRegistry[string];
}

test("a wedged provider readiness degrades to unreachable within the injected timeout, not a hang", async () => {
  const providers = {
    // Readiness never settles; with a 20ms probe budget it must still resolve as unreachable.
    hung: provider({
      kind: "cloud",
      readiness: () => Effect.never as ReturnType<ProviderRegistry[string]["readiness"]>,
      onMutate: () => assert.fail("a health probe must never warm/stream a provider"),
    }),
  } as unknown as ProviderRegistry;

  const start = Date.now();
  const results = await collectDoctorProbeResults(providers, { probeTimeoutMs: 20 });
  const elapsed = Date.now() - start;

  assert.equal(
    results.providers[0]?.status,
    "unreachable",
    "a timed-out readiness reads unreachable",
  );
  assert.ok(elapsed < 2000, "the bounded probe returns well before the default 2s budget");
});

test("running /doctor probes never warm, load, or stream a provider (non-mutating)", async () => {
  let mutated = false;
  const providers = {
    warm: provider({
      kind: "local",
      readiness: () => Effect.succeed({ ready: true, warm: true }),
      onMutate: () => {
        mutated = true;
      },
    }),
    cold: provider({
      kind: "cloud",
      readiness: () => Effect.succeed({ ready: true, warm: false }),
      onMutate: () => {
        mutated = true;
      },
    }),
  } as unknown as ProviderRegistry;

  const results = await collectDoctorProbeResults(providers);
  assert.equal(mutated, false, "no probe touched a mutating provider surface");
  assert.deepEqual(
    results.providers.map((p) => p.status).sort(),
    ["cold", "warm"],
    "readiness alone drives the warm/cold verdict",
  );
});
