import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount any React tree rendered by a test so the jsdom document is clean for the next one.
afterEach(cleanup);
