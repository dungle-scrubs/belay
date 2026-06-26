import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount any React tree rendered by a test so the jsdom document is clean for the next one.
afterEach(cleanup);

// jsdom has no layout engine, so it ships neither of these. cmdk (the command modal) and
// some Radix primitives observe element size / scroll the active item into view on mount;
// stub both so component tests can render them. No-ops are sufficient - the tests assert on
// DOM presence + callbacks, not on measured geometry.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => {};
}
