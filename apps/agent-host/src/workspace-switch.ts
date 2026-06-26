import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { freshSessionId } from "@trevor/session";

export interface WorkspaceSwitchFs {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  realpath(path: string): string;
}

export interface CdTarget {
  readonly cwd: string;
  readonly sessionId: string;
  readonly workspace: string;
}

export type CdTargetResult =
  | { readonly ok: true; readonly value: CdTarget }
  | { readonly ok: false; readonly error: string };

export interface ResolveCdTargetOptions {
  readonly cwd: string;
  readonly fs?: WorkspaceSwitchFs;
  readonly home?: string;
  readonly now?: Date;
  readonly random?: string;
}

export const nodeWorkspaceSwitchFs: WorkspaceSwitchFs = {
  exists: (path) => existsSync(path),
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  realpath: (path) => realpathSync(path),
};

function expandHome(input: string, home: string): string {
  if (input === "~") {
    return home;
  }
  return input.startsWith("~/") ? join(home, input.slice(2)) : input;
}

function stripMatchingQuotes(input: string): string {
  const first = input[0];
  const last = input[input.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return input.slice(1, -1);
  }
  return input;
}

export function resolveWorkspaceRoot(cwd: string, fs: WorkspaceSwitchFs): string {
  let dir = cwd;
  for (;;) {
    if (fs.exists(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return cwd;
    }
    dir = parent;
  }
}

export function resolveCdTarget(args: string, options: ResolveCdTargetOptions): CdTargetResult {
  const raw = stripMatchingQuotes(args.trim());
  if (!raw) {
    return { ok: false, error: "usage: /cd <directory>" };
  }

  const fs = options.fs ?? nodeWorkspaceSwitchFs;
  const home = options.home ?? homedir();
  const absolute = resolve(options.cwd, expandHome(raw, home));

  if (!fs.exists(absolute)) {
    return { ok: false, error: `No such directory: ${absolute}` };
  }
  if (!fs.isDirectory(absolute)) {
    return { ok: false, error: `Not a directory: ${absolute}` };
  }

  let cwd: string;
  try {
    cwd = fs.realpath(absolute);
  } catch (error) {
    return {
      ok: false,
      error: `Could not resolve directory: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const workspace = resolveWorkspaceRoot(cwd, fs);
  return {
    ok: true,
    value: {
      cwd,
      sessionId: freshSessionId({
        now: options.now,
        prefix: basename(cwd) || "trevor",
        random: options.random,
      }),
      workspace,
    },
  };
}

export function gitBranch(cwd: string): string | null {
  const branch = spawnSync("git", ["branch", "--show-current"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const branchName = branch.status === 0 ? branch.stdout.trim() : "";
  if (branchName) {
    return branchName;
  }

  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const sha = head.status === 0 ? head.stdout.trim() : "";
  return sha ? `detached ${sha}` : null;
}
