#!/usr/bin/env node
// The `belay` terminal executable (D-085). The CLI itself is TypeScript run through tsx (the repo
// has no build step); this shim resolves the workspace tsx binary and execs `src/main.ts`, forwarding
// argv. Installed on PATH via `pnpm --filter @belay/cli link --global`, or run as `pnpm belay`.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "src", "main.ts");
const require = createRequire(import.meta.url);
// Resolve the tsx CLI from this package's node_modules (workspace devDep) so the shim never depends
// on a global tsx.
const tsxCli = require.resolve("tsx/cli");

const child = spawn(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
