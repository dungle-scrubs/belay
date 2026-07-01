import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { createMemoryStorage } from "@/test-support/storage";

// Unmount any React tree rendered by a test so the jsdom document is clean for the next one.
afterEach(cleanup);

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  });
}

if (typeof globalThis.sessionStorage === "undefined") {
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: memoryStorage(),
  });
}

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

const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

let hasUsableLocalStorage = false;

if (localStorageDescriptor?.value !== undefined) {
  try {
    const storage = localStorageDescriptor.value as Storage;
    hasUsableLocalStorage =
      storage !== undefined &&
      typeof storage.getItem === "function" &&
      typeof storage.setItem === "function" &&
      typeof storage.clear === "function";
  } catch {
    hasUsableLocalStorage = false;
  }
}

if (!hasUsableLocalStorage) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: createMemoryStorage(),
  });
}
