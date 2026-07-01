import { describe, expect, it } from "vitest";
import {
  DENIED_CAPABILITIES,
  fallbackSandboxMode,
  isOsSandboxMode,
  selectSandboxMode,
} from "./tool-script-sandbox";

describe("tool_script deny-first threat model (M2)", () => {
  it("denies every ambient capability - a script reaches power ONLY through the host bridge", () => {
    for (const cap of [
      "filesystem",
      "network",
      "environment",
      "process",
      "import",
      "package",
      "shell",
      "native",
    ]) {
      expect(DENIED_CAPABILITIES).toContain(cap);
    }
  });
});

describe("tool_script sandbox mode selection + fallback (M2)", () => {
  it("prefers Safehouse when available", () => {
    expect(
      selectSandboxMode({
        platform: "darwin",
        safehouseAvailable: true,
        sandboxExecAvailable: true,
      }),
    ).toBe("safehouse");
  });

  it("uses sandbox-exec on macOS when Safehouse is unavailable", () => {
    expect(
      selectSandboxMode({
        platform: "darwin",
        safehouseAvailable: false,
        sandboxExecAvailable: true,
      }),
    ).toBe("sandbox-exec");
  });

  it("falls back to the child-process boundary off macOS (or when no OS sandbox is available)", () => {
    expect(
      selectSandboxMode({
        platform: "linux",
        safehouseAvailable: false,
        sandboxExecAvailable: false,
      }),
    ).toBe("child-process");
    // macOS but sandbox-exec somehow missing -> still the process boundary, never ambient.
    expect(
      selectSandboxMode({
        platform: "darwin",
        safehouseAvailable: false,
        sandboxExecAvailable: false,
      }),
    ).toBe("child-process");
  });

  it("on an OS-sandbox LAUNCH FAILURE, degrades to the child-process boundary, never to no isolation", () => {
    expect(fallbackSandboxMode("safehouse")).toBe("child-process");
    expect(fallbackSandboxMode("sandbox-exec")).toBe("child-process");
    // Already at the floor: it stays there (there is no weaker safe mode).
    expect(fallbackSandboxMode("child-process")).toBe("child-process");
  });

  it("distinguishes OS-sandbox modes from the plain process boundary", () => {
    expect(isOsSandboxMode("safehouse")).toBe(true);
    expect(isOsSandboxMode("sandbox-exec")).toBe(true);
    expect(isOsSandboxMode("child-process")).toBe(false);
    expect(isOsSandboxMode("none")).toBe(false);
  });
});
