import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTypeScriptLanguageServerAdapter } from "@host/lsp/adapter";
import { afterEach, describe, expect, it } from "vitest";

/**
 * TS/JS adapter integration (plan 24 M2 tasks 3-4): workspace detection against real temp
 * directories (tsconfig/jsconfig/package.json-with-TS-deps) and command resolution
 * (workspace-local node_modules/.bin first, then PATH, else undefined = not installed).
 */

const cleanups: string[] = [];

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "trevor-lsp-adapter-"));
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeBinary(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

describe("typescript adapter - workspace detection", () => {
  it("detects a tsconfig.json workspace", () => {
    const root = tempWorkspace();
    writeFileSync(join(root, "tsconfig.json"), "{}");
    expect(createTypeScriptLanguageServerAdapter().detects(root)).toBe(true);
  });

  it("detects a jsconfig.json workspace", () => {
    const root = tempWorkspace();
    writeFileSync(join(root, "jsconfig.json"), "{}");
    expect(createTypeScriptLanguageServerAdapter().detects(root)).toBe(true);
  });

  it("detects a package.json with a typescript dependency (deps or devDeps)", () => {
    const withDep = tempWorkspace();
    writeFileSync(
      join(withDep, "package.json"),
      JSON.stringify({ dependencies: { typescript: "^5" } }),
    );
    expect(createTypeScriptLanguageServerAdapter().detects(withDep)).toBe(true);

    const withDevDep = tempWorkspace();
    writeFileSync(
      join(withDevDep, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "^5" } }),
    );
    expect(createTypeScriptLanguageServerAdapter().detects(withDevDep)).toBe(true);
  });

  it("does not detect an empty dir, a TS-free package.json, or malformed JSON", () => {
    const adapter = createTypeScriptLanguageServerAdapter();
    expect(adapter.detects(tempWorkspace())).toBe(false);

    const noTs = tempWorkspace();
    writeFileSync(join(noTs, "package.json"), JSON.stringify({ dependencies: { react: "^19" } }));
    expect(adapter.detects(noTs)).toBe(false);

    const malformed = tempWorkspace();
    writeFileSync(join(malformed, "package.json"), "{ not json");
    expect(adapter.detects(malformed)).toBe(false);
  });
});

describe("typescript adapter - command resolution", () => {
  it("prefers the workspace-local node_modules/.bin binary", () => {
    const root = tempWorkspace();
    const local = fakeBinary(join(root, "node_modules", ".bin"), "typescript-language-server");
    const spawn = createTypeScriptLanguageServerAdapter({
      hostEnv: { PATH: "/nonexistent" },
    }).resolveCommand(root);
    expect(spawn).toEqual({ command: local, args: ["--stdio"] });
  });

  it("falls back to a PATH binary when the workspace has none", () => {
    const root = tempWorkspace();
    const binDir = join(tempWorkspace(), "bin");
    const onPath = fakeBinary(binDir, "typescript-language-server");
    const spawn = createTypeScriptLanguageServerAdapter({
      hostEnv: { PATH: `/nonexistent:${binDir}` },
    }).resolveCommand(root);
    expect(spawn).toEqual({ command: onPath, args: ["--stdio"] });
  });

  it("resolves to undefined when the binary exists nowhere (missing -> unavailable)", () => {
    const spawn = createTypeScriptLanguageServerAdapter({
      hostEnv: { PATH: "/nonexistent" },
    }).resolveCommand(tempWorkspace());
    expect(spawn).toBeUndefined();
  });

  it("names the server for status displays", () => {
    const adapter = createTypeScriptLanguageServerAdapter();
    expect(adapter.id).toBe("typescript");
    expect(adapter.displayName).toBe("typescript-language-server");
  });
});
