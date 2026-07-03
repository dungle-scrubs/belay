import { describe, expect, test } from "vitest";
import { classifyPeripheral, type PeripheralClassificationRule } from "./peripheral-classifier";
import type { PeripheralState } from "./probe-input";

type Entry = {
  readonly enabled: boolean;
  readonly status: "ready" | "warn" | "error";
  readonly name: string;
};

const entry = (over: Partial<Entry> = {}): Entry => ({
  enabled: true,
  name: "one",
  status: "ready",
  ...over,
});

describe("classifyPeripheral", () => {
  test("returns unconfigured when no entries match the configured predicate", () => {
    expect(classifyPeripheral([entry({ enabled: false })], baseOptions())).toEqual({
      kind: "unconfigured",
    });
  });

  test("applies rules in precedence order before the ready fallback", () => {
    const state = classifyPeripheral(
      [entry({ status: "warn" }), entry({ status: "error", name: "bad" })],
      baseOptions(),
    );

    expect(state).toEqual({ kind: "error", detail: "bad" });
  });

  test("uses the ready fallback with the configured entries", () => {
    const state = classifyPeripheral(
      [entry({ enabled: false }), entry({ name: "ready" })],
      baseOptions(),
    );

    expect(state).toEqual({ kind: "ready", detail: "ready" });
  });
});

function baseOptions(): {
  readonly configured: (item: Entry) => boolean;
  readonly rules: readonly PeripheralClassificationRule<Entry>[];
  readonly ready: (items: readonly [Entry, ...Entry[]]) => PeripheralState;
} {
  return {
    configured: (item: Entry) => item.enabled,
    rules: [
      {
        when: (item: Entry) => item.status === "error",
        state: (items) => ({ kind: "error", detail: items[0].name }),
      },
      {
        when: (item: Entry) => item.status === "warn",
        state: (items) => ({ kind: "unavailable", detail: items[0].name }),
      },
    ],
    ready: (items) => ({ kind: "ready", detail: items[0].name }),
  };
}
