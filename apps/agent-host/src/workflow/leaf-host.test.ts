import { Effect, Either } from "effect";
import { describe, expect, test } from "vitest";
import type { Provider } from "../providers";
import { mapCompletionToOutcome, resolveLeafProvider } from "./leaf-host";
import type { ModelRef } from "./spec";

const model: ModelRef = { sourceId: "src", modelId: "mod", reasoning: null };

const fakeProviderOf = (kind: "local" | "cloud", warm: boolean): Provider =>
  ({
    id: `${kind}-provider`,
    model: "m",
    kind,
    readiness: () => Effect.succeed({ ready: true, warm }),
  }) as unknown as Provider;

describe("mapCompletionToOutcome", () => {
  test("an error takes precedence and carries the cause", () => {
    const outcome = mapCompletionToOutcome({ text: "partial", error: "provider 500" });
    expect(outcome.endReason).toBe("error");
    expect(outcome.cause).toBe("provider 500");
  });

  test("a cancelled completion maps to cancelled", () => {
    expect(mapCompletionToOutcome({ cancelled: true }).endReason).toBe("cancelled");
  });

  test("a budget-terminated turn (stepLimit > 0) maps to cutoff", () => {
    expect(mapCompletionToOutcome({ text: "forced", stepLimit: 5 }).endReason).toBe("cutoff");
  });

  test("a clean completion maps to answered", () => {
    expect(mapCompletionToOutcome({ text: "done" }).endReason).toBe("answered");
  });

  test("carries the turn usage", () => {
    const outcome = mapCompletionToOutcome({ text: "x", usage: { input: 5, output: 9 } });
    expect(outcome.usage).toEqual({ input: 5, output: 9 });
  });
});

describe("resolveLeafProvider", () => {
  const run = (p: Provider | null) =>
    Effect.runPromise(resolveLeafProvider(model, "c1", { buildProvider: () => p }));

  test("an uncatalogued model fails model-unresolvable", async () => {
    const result = await run(null);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.kind).toBe("model-unresolvable");
    }
  });

  test("a cloud provider passes through (always warm)", async () => {
    const result = await run(fakeProviderOf("cloud", true));
    expect(Either.isRight(result)).toBe(true);
  });

  test("a cold local model fails local-not-ready", async () => {
    const result = await run(fakeProviderOf("local", false));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.kind).toBe("local-not-ready");
    }
  });

  test("a warm local model passes the readiness gate", async () => {
    const result = await run(fakeProviderOf("local", true));
    expect(Either.isRight(result)).toBe(true);
  });
});
