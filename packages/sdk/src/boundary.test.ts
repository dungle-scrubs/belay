import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Package-boundary tests (plan 28 M1 + M11): they enforce the intended dependency GRAPH by reading real
 * package manifests and source, not by importing anything. The SDK is the ergonomic layer ABOVE
 * `@belay/session`; it must depend on the protocol package, never reach back up into an app
 * (`@belay/cli`, `@belay/web`, `@belay/agent-host`), and never pull in server plumbing. A regression
 * here (a stray import that inverts the layering) fails this suite rather than silently coupling the
 * package to a consumer.
 */

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    try {
      statSync(join(dir, "pnpm-workspace.yaml"));
      return dir;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error("could not locate repo root (pnpm-workspace.yaml)");
}

const ROOT = repoRoot();

function readManifest(pkgDir: string): { dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(ROOT, pkgDir, "package.json"), "utf8"));
}

function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSources(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  for (const match of text.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

describe("@belay/sdk package boundary", () => {
  it("depends on @belay/session and not on any app or server plumbing", () => {
    const deps = Object.keys(readManifest("packages/sdk").dependencies ?? {});
    expect(deps).toContain("@belay/session");
    for (const forbidden of [
      "@belay/cli",
      "@belay/web",
      "@belay/agent-host",
      "@belay/server-kit",
      "@belay/session-store",
      "@belay/blob-store",
    ]) {
      expect(deps).not.toContain(forbidden);
    }
  });

  it("imports @belay/session primitives rather than duplicating event/session types", () => {
    const sources = walkSources(join(ROOT, "packages/sdk/src"));
    const usesSession = sources.some((file) =>
      importsOf(file).some((spec) => spec.startsWith("@belay/session")),
    );
    expect(usesSession).toBe(true);
  });

  it("never imports an app or server-plumbing package from source", () => {
    const forbidden = [
      "@belay/cli",
      "@belay/web",
      "@belay/agent-host",
      "@belay/server-kit",
      "@belay/session-store",
      "@belay/blob-store",
    ];
    for (const file of walkSources(join(ROOT, "packages/sdk/src"))) {
      for (const spec of importsOf(file)) {
        expect(
          forbidden.some((f) => spec === f || spec.startsWith(`${f}/`)),
          `${file} imports forbidden ${spec}`,
        ).toBe(false);
        expect(spec.includes("/apps/"), `${file} reaches into an app: ${spec}`).toBe(false);
      }
    }
  });

  it("CLI is allowed to depend on the SDK (direction: app -> package)", () => {
    // The SDK may not depend on the CLI; the CLI depending on the SDK is the intended direction and is
    // asserted here so a future removal of that edge (regressing the CLI to bypass the SDK) is visible.
    const cliDeps = Object.keys(readManifest("apps/belay-cli").dependencies ?? {});
    expect(cliDeps).toContain("@belay/sdk");
  });
});
