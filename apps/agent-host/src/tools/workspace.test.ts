import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import {
  currentLeafWorkspace,
  resolveCwd,
  resolveWorkspaceRoot,
  withLeafWorkspace,
} from "./workspace";

describe("workspace resolvers", () => {
  test("resolveCwd defaults to process.cwd(), overridden by ctx.cwd", () => {
    expect(resolveCwd()).toBe(process.cwd());
    expect(resolveCwd({ cwd: "/tmp/leaf-tree" })).toBe("/tmp/leaf-tree");
  });

  test("resolveWorkspaceRoot defaults to the global root, overridden by ctx.workspaceRoot", () => {
    expect(typeof resolveWorkspaceRoot()).toBe("string");
    expect(resolveWorkspaceRoot({ workspaceRoot: "/tmp/leaf-tree" })).toBe("/tmp/leaf-tree");
  });
});

describe("withLeafWorkspace", () => {
  test("is null outside, set inside, and does not leak across sibling fibers", async () => {
    expect(await Effect.runPromise(currentLeafWorkspace)).toBeNull();

    const [a, b] = await Effect.runPromise(
      Effect.all(
        [
          withLeafWorkspace({ cwd: "/a", root: "/a" }, currentLeafWorkspace),
          withLeafWorkspace({ cwd: "/b", root: "/b" }, currentLeafWorkspace),
        ],
        { concurrency: 2 },
      ),
    );
    expect(a).toEqual({ cwd: "/a", root: "/a" });
    expect(b).toEqual({ cwd: "/b", root: "/b" });

    // Still null after the scoped runs (no ambient mutation).
    expect(await Effect.runPromise(currentLeafWorkspace)).toBeNull();
  });

  test("restores the caller's workspace after its scope, WITHIN one fiber (no sequential leak)", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const before = yield* currentLeafWorkspace;
        const inside = yield* withLeafWorkspace(
          { cwd: "/leaf", root: "/leaf" },
          currentLeafWorkspace,
        );
        const after = yield* currentLeafWorkspace;
        return { before, inside, after };
      }),
    );
    expect(observed.before).toBeNull();
    expect(observed.inside).toEqual({ cwd: "/leaf", root: "/leaf" });
    expect(observed.after).toBeNull(); // restored - a bare FiberRef.set would leak "/leaf" here
  });

  test("a fan-out does NOT clobber the parent workspace (child-value-wins join guarded)", async () => {
    const after = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.all(
          [
            withLeafWorkspace({ cwd: "/a", root: "/a" }, Effect.void),
            withLeafWorkspace({ cwd: "/b", root: "/b" }, Effect.void),
          ],
          { concurrency: 2 },
        );
        return yield* currentLeafWorkspace;
      }),
    );
    expect(after).toBeNull(); // parent not clobbered by a child's workspace
  });
});

describe("cwd de-globalization guard (D-024)", () => {
  const dir = import.meta.dirname;

  test("the host-cwd tools read no bare process.cwd() (all route through resolveCwd)", () => {
    for (const file of ["bash.ts", "read.ts", "write.ts"]) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, `${file} still reads a bare process.cwd()`).not.toMatch(/process\.cwd\(\)/);
      expect(source, `${file} does not route through resolveCwd`).toMatch(/resolveCwd/);
    }
  });

  test("the confined tools route their root through resolveWorkspaceRoot", () => {
    for (const file of ["edit.ts", "multi-edit.ts", "glob.ts", "grep.ts", "ast-grep.ts"]) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, `${file} does not route through resolveWorkspaceRoot`).toMatch(
        /resolveWorkspaceRoot/,
      );
    }
  });
});
