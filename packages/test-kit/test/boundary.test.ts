import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * M9 boundary: `@belay/test-kit` is test infrastructure, not an app and not the SDK. It boots the stores
 * and now binds an SDK client to them, but it must stay bootable WITHOUT the agent-host or the web app -
 * so it may not depend on, or import from, either. A regression (a fixture reaching into the host/web)
 * fails here rather than silently coupling every test to the product it is supposed to drive from outside.
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

function manifestDeps(pkgDir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(ROOT, pkgDir, "package.json"), "utf8"));
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ];
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

const FORBIDDEN = ["@belay/agent-host", "@belay/web"];

describe("@belay/test-kit stays test-only", () => {
  it("does not depend on the agent-host or the web app", () => {
    const deps = manifestDeps("packages/test-kit");
    for (const forbidden of FORBIDDEN) {
      expect(deps).not.toContain(forbidden);
    }
  });

  it("depends on the SDK so it can bind an SDK client to the booted stores", () => {
    expect(manifestDeps("packages/test-kit")).toContain("@belay/sdk");
  });

  it("never imports the agent-host or web app from source", () => {
    for (const file of walkSources(join(ROOT, "packages/test-kit/src"))) {
      for (const spec of importsOf(file)) {
        expect(
          FORBIDDEN.some((f) => spec === f || spec.startsWith(`${f}/`)),
          `${file} imports forbidden ${spec}`,
        ).toBe(false);
        expect(spec.includes("/apps/"), `${file} reaches into an app: ${spec}`).toBe(false);
      }
    }
  });
});
