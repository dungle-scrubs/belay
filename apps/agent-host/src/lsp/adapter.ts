import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { asRecord } from "@host/boot/decode";

/**
 * The generic language-server adapter boundary (plan 24 M2, D-004): what the runtime manager
 * needs to know about one project family - does this workspace match, how to launch the
 * server, what to call it, and its initialize options. The public tool contract (./contract)
 * never sees an adapter, so later language adapters slot in without changing tool schemas.
 * TS/JS is the first family: typescript-language-server over stdio, resolved workspace-local
 * (node_modules/.bin) first, then PATH; an unresolvable binary is data (undefined), which the
 * manager surfaces as an unavailable degraded result (D-006), never a throw.
 *
 * Responsible for: the LanguageServerAdapter interface and the TS/JS adapter.
 * Not for: process lifecycle (./client) or workspace state and status (./manager).
 */

/** How to launch a language server child process. */
export interface LspSpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
}

export interface LanguageServerAdapter {
  /** Stable adapter identity ("typescript"). */
  readonly id: string;
  /** The server's display name for status/errors ("typescript-language-server"). */
  readonly displayName: string;
  /** True when the workspace looks like this adapter's project family. */
  readonly detects: (workspaceRoot: string) => boolean;
  /** Resolves the launch command (workspace-local first, then PATH); undefined = not installed. */
  readonly resolveCommand: (workspaceRoot: string) => LspSpawnSpec | undefined;
  /** LSP initializationOptions passed through the initialize request. */
  readonly initializeOptions?: unknown;
}

const TS_SERVER_BINARY = "typescript-language-server";

export interface TypeScriptAdapterOptions {
  /** The env whose PATH backs the fallback binary lookup (default `process.env`). */
  readonly hostEnv?: NodeJS.ProcessEnv;
}

/**
 * The TS/JS adapter (D-004 first cut): matches a workspace carrying tsconfig.json,
 * jsconfig.json, or a package.json depending on typescript.
 */
export function createTypeScriptLanguageServerAdapter(
  options: TypeScriptAdapterOptions = {},
): LanguageServerAdapter {
  const env = options.hostEnv ?? process.env;
  return {
    id: "typescript",
    displayName: TS_SERVER_BINARY,
    initializeOptions: { hostInfo: "trevor" },
    detects: (workspaceRoot) =>
      isFile(join(workspaceRoot, "tsconfig.json")) ||
      isFile(join(workspaceRoot, "jsconfig.json")) ||
      dependsOnTypeScript(join(workspaceRoot, "package.json")),
    resolveCommand: (workspaceRoot) => {
      const local = join(workspaceRoot, "node_modules", ".bin", TS_SERVER_BINARY);
      if (isExecutable(local)) {
        return { command: local, args: ["--stdio"] };
      }
      for (const dir of (env.PATH ?? "").split(delimiter)) {
        if (dir.length === 0) {
          continue;
        }
        const candidate = join(dir, TS_SERVER_BINARY);
        if (isExecutable(candidate)) {
          return { command: candidate, args: ["--stdio"] };
        }
      }
      return undefined;
    },
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when package.json names typescript in dependencies or devDependencies. Tolerant:
 *  absent or malformed JSON is simply "no". */
function dependsOnTypeScript(packageJsonPath: string): boolean {
  let record: Record<string, unknown> | undefined;
  try {
    record = asRecord(JSON.parse(readFileSync(packageJsonPath, "utf8")));
  } catch {
    return false;
  }
  if (!record) {
    return false;
  }
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = asRecord(record[field]);
    if (deps && "typescript" in deps) {
      return true;
    }
  }
  return false;
}
