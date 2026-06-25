import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// One runner, four projects, split by scope (see repo-root AGENTS.md "Testing"):
//   unit        - co-located *.test.ts beside source; pure, fast, no I/O
//   integration - a package's test/ dir; real local deps (sockets, temp dirs)
//   web         - apps/web *.test.tsx under jsdom (components, hooks)
//   e2e         - the top-level e2e/ workspace; boots services, serial
// Select a tier with `pnpm test:unit|test:integration|test:web|test:e2e`.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
          environment: "node",
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["e2e/**/*.test.ts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // Services contend for ports/CPU; run e2e files one at a time.
          fileParallelism: false,
        },
      },
      {
        // Web component / hook DOM tests: *.test.tsx under a simulated DOM. The node-env
        // `unit` project only globs *.test.ts, so the two never overlap. (Vitest 4's oxc
        // transform handles the React 19 automatic JSX runtime with no extra config.)
        resolve: { alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) } },
        test: {
          name: "web",
          include: ["apps/web/src/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["./apps/web/vitest.setup.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["apps/*/src/**", "packages/*/src/**"],
      exclude: ["**/*.test.ts", "**/index.ts"],
    },
  },
});
