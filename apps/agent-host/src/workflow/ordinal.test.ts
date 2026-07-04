import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { consumeOrdinal, ordinalKey, withChildSlot, withRootSlot } from "./ordinal";

describe("ordinal", () => {
  test("a root slot yields program-order ordinals", async () => {
    const out = await Effect.runPromise(
      withRootSlot(
        Effect.gen(function* () {
          const a = yield* consumeOrdinal;
          const b = yield* consumeOrdinal;
          return [ordinalKey(a), ordinalKey(b)];
        }),
      ),
    );
    expect(out).toEqual(["0", "1"]);
  });

  test("a child slot keys under its base with its own intra-slot counter", async () => {
    const out = await Effect.runPromise(
      withRootSlot(
        Effect.gen(function* () {
          const base = yield* consumeOrdinal; // [0]
          return yield* withChildSlot(
            [...base, 3],
            Effect.gen(function* () {
              const x = yield* consumeOrdinal; // [0,3,0]
              const y = yield* consumeOrdinal; // [0,3,1]
              return [ordinalKey(x), ordinalKey(y)];
            }),
          );
        }),
      ),
    );
    expect(out).toEqual(["0.3.0", "0.3.1"]);
  });

  test("each run restarts ordinals from a fresh root", async () => {
    const once = () => Effect.runPromise(withRootSlot(consumeOrdinal.pipe(Effect.map(ordinalKey))));
    expect(await once()).toBe("0");
    expect(await once()).toBe("0");
  });

  test("a child slot does NOT leak into the parent slot after it (Effect.locally restore)", async () => {
    const out = await Effect.runPromise(
      withRootSlot(
        Effect.gen(function* () {
          const a = yield* consumeOrdinal; // [0]
          yield* withChildSlot(
            [...a, 5],
            Effect.gen(function* () {
              yield* consumeOrdinal; // [0,5,0]
              yield* consumeOrdinal; // [0,5,1]
            }),
          );
          const b = yield* consumeOrdinal; // must be [1], not a leaked child slot
          return [ordinalKey(a), ordinalKey(b)];
        }),
      ),
    );
    expect(out).toEqual(["0", "1"]);
  });
});
