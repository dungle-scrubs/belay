import * as sdk from "@trevor/sdk";
import { describe, expect, it } from "vitest";
import * as lifecycle from "./lifecycle";

/**
 * CLI-over-SDK boundary (plan 28 M7). Two directions are pinned here:
 *  1. The launcher-only behavior stays in the app: the SDK exposes NO process-signalling, host-spawn,
 *     service-readiness, or browser-open surface. OS signalling (`runStop` -> SIGTERM/SIGKILL) is a CLI
 *     concern; the SDK's only run control is the protocol-safe `cancel` (`cancelRun`), a different thing.
 *  2. The pure lifecycle workflow has ONE source: the CLI re-exports the SAME function references the SDK
 *     owns, so `list`/`open-target` semantics cannot drift between the CLI and any other headless consumer.
 */

describe("SDK exposes no launcher/OS surface (M7)", () => {
  it("has no process-signal, host-spawn, service, or browser exports", () => {
    for (const forbidden of [
      "stop",
      "kill",
      "signal",
      "spawnHost",
      "openBrowser",
      "startService",
      "runStop",
    ]) {
      expect(sdk).not.toHaveProperty(forbidden);
    }
  });

  it("offers protocol-safe cancel, not stop/kill", () => {
    expect(typeof sdk.cancelRun).toBe("function");
  });
});

describe("pure lifecycle workflow has one source (M7)", () => {
  it("the CLI re-exports the SDK's selection/resolution functions by identity", () => {
    expect(lifecycle.selectSessions).toBe(sdk.selectSessions);
    expect(lifecycle.resolveOpenTarget).toBe(sdk.resolveOpenTarget);
    expect(lifecycle.expandHome).toBe(sdk.expandHome);
  });

  it("keeps terminal rendering and OS signalling in the CLI, not the SDK", () => {
    expect(typeof lifecycle.renderSessions).toBe("function");
    expect(typeof lifecycle.runStop).toBe("function");
    expect(sdk).not.toHaveProperty("renderSessions");
  });
});
