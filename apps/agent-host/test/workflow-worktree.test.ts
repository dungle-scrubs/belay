import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "@host/tools/index";
import { type LeafWorkspace, withLeafWorkspace } from "@host/tools/workspace";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";

/**
 * The load-bearing M6 property (plan 21 / 46 D-010): N parallel worktree leaves in ONE host process
 * write to DISTINCT trees without racing. Proven end-to-end through the real executeTool boundary -
 * a write tool run under two distinct fiber-local leaf workspaces lands its file in each leaf's own
 * tree, concurrently, with no collision. process.chdir() could not do this (it is process-global).
 */
describe("per-leaf worktree cwd routing", () => {
  test("two parallel leaves write to distinct trees via the real tool boundary", async () => {
    const treeA = mkdtempSync(join(tmpdir(), "leaf-a-"));
    const treeB = mkdtempSync(join(tmpdir(), "leaf-b-"));
    const write = (workspace: LeafWorkspace, content: string) =>
      withLeafWorkspace(
        workspace,
        executeTool("write", JSON.stringify({ path: "out.txt", content })),
      );

    await Effect.runPromise(
      Effect.all(
        [
          write({ cwd: treeA, root: treeA }, "from-leaf-A"),
          write({ cwd: treeB, root: treeB }, "from-leaf-B"),
        ],
        { concurrency: 2 },
      ),
    );

    expect(readFileSync(join(treeA, "out.txt"), "utf8")).toBe("from-leaf-A");
    expect(readFileSync(join(treeB, "out.txt"), "utf8")).toBe("from-leaf-B");
  });

  test("a read tool resolves relative paths against the leaf's tree", async () => {
    const tree = mkdtempSync(join(tmpdir(), "leaf-read-"));
    await Effect.runPromise(
      withLeafWorkspace(
        { cwd: tree, root: tree },
        executeTool("write", JSON.stringify({ path: "note.txt", content: "leaf-local" })),
      ),
    );
    const out = await Effect.runPromise(
      withLeafWorkspace(
        { cwd: tree, root: tree },
        executeTool("read", JSON.stringify({ path: "note.txt" })),
      ),
    );
    expect(out).toBe("leaf-local");
  });
});
