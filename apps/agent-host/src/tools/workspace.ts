/**
 * Per-leaf workspace routing for the tool boundary (plan 21 M6, D-024). A worktree-isolated workflow
 * leaf runs its child turns with a FIBER-LOCAL workspace (its own tree) so N parallel leaves in ONE
 * host process operate on DISTINCT trees - `process.chdir()` is process-global and cannot. The leaf
 * sets `LeafWorkspaceRef`; `executeTool` reads it and injects `{ cwd, workspaceRoot }` into the
 * `ToolContext`; the cwd/root-reading tools resolve against that instead of the ambient
 * `process.cwd()` / global `WORKSPACE_ROOT`. Default (unset) = the ambient globals, so every existing
 * (non-leaf) turn is byte-for-byte unchanged.
 *
 * Responsible for: the fiber-local leaf workspace, the `ToolContext` resolvers with the global
 * fallback, and the `withLeafWorkspace` scoping helper.
 * Not for: provisioning the worktree itself (01's `WorktreeManager`) or the tool bodies that consume
 * the resolved cwd/root.
 */
import { WORKSPACE_ROOT } from "@host/boot/paths";
import { Effect, FiberRef } from "effect";
import type { ToolContext } from "./types";

/** A leaf's workspace: the host cwd for `read`/`write`/`bash`, and the confinement root for
 *  `edit`/`glob`/`grep`. For a worktree leaf both are its tree. */
export interface LeafWorkspace {
  readonly cwd: string;
  readonly root: string;
}

/** The fiber-local leaf workspace; null = use the ambient globals (every non-leaf turn). */
export const LeafWorkspaceRef = FiberRef.unsafeMake<LeafWorkspace | null>(null);

/** Read the current fiber's leaf workspace (null when none is set). */
export const currentLeafWorkspace: Effect.Effect<LeafWorkspace | null> =
  FiberRef.get(LeafWorkspaceRef);

/** The host cwd a tool resolves against: the leaf's cwd from `ctx`, else the ambient `process.cwd()`. */
export function resolveCwd(ctx?: ToolContext): string {
  return ctx?.cwd ?? process.cwd();
}

/** The workspace root a confined tool resolves against: the leaf's root from `ctx`, else the global. */
export function resolveWorkspaceRoot(ctx?: ToolContext): string {
  return ctx?.workspaceRoot ?? WORKSPACE_ROOT;
}

/** Run `effect` with the leaf workspace set for its fiber (and any child fibers it forks), so the
 *  leaf's tool calls resolve against `workspace` while sibling leaves keep their own. */
export function withLeafWorkspace<A, E, R>(
  workspace: LeafWorkspace,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return FiberRef.set(LeafWorkspaceRef, workspace).pipe(Effect.flatMap(() => effect));
}
