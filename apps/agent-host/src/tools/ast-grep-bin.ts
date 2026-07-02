import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Resolves the project-managed `ast-grep` binary (the platform optional-dependency of
 * `@ast-grep/cli`), never a system/Homebrew `sg`. `@ast-grep/cli` ships the binary inside a
 * per-platform package (`@ast-grep/cli-<platform>-<arch>`); we resolve that package relative to
 * `@ast-grep/cli` and point at its `ast-grep` executable - the same detection its postinstall uses,
 * but without depending on the postinstall having run. Resolved once and memoized.
 *
 * Responsible for: resolving the packaged @ast-grep/cli platform binary path (memoized).
 * Not for: running searches - ast-grep.ts.
 */

function detectPackageName(): string | null {
  const { platform, arch } = process;
  switch (platform) {
    case "darwin":
      return arch === "arm64" ? "@ast-grep/cli-darwin-arm64" : "@ast-grep/cli-darwin-x64";
    case "linux":
      return arch === "arm64" ? "@ast-grep/cli-linux-arm64-gnu" : "@ast-grep/cli-linux-x64-gnu";
    case "win32":
      if (arch === "arm64") return "@ast-grep/cli-win32-arm64-msvc";
      if (arch === "ia32") return "@ast-grep/cli-win32-ia32-msvc";
      return "@ast-grep/cli-win32-x64-msvc";
    default:
      return null;
  }
}

let cached: string | null | undefined;

/** The absolute path to the ast-grep binary, or null when no platform package is installed. */
export function astGrepPath(): string | null {
  if (cached !== undefined) {
    return cached;
  }
  cached = null;
  const pkg = detectPackageName();
  if (!pkg) {
    return null;
  }
  try {
    const require = createRequire(import.meta.url);
    const cliDir = dirname(require.resolve("@ast-grep/cli/package.json"));
    const dir = dirname(require.resolve(`${pkg}/package.json`, { paths: [cliDir] }));
    const bin = join(dir, process.platform === "win32" ? "ast-grep.exe" : "ast-grep");
    if (existsSync(bin)) {
      cached = bin;
    }
  } catch {
    cached = null;
  }
  return cached;
}
