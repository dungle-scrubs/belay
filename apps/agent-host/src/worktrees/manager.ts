import { basename } from "node:path";
import type { WorktreeSummary } from "@trevor/session";
import { projectSessionId } from "@trevor/session";
import type { GitRunner } from "../git-status";
import {
  addWorktree,
  diffStat,
  type GitResult,
  headCommit,
  mainWorktreeRoot,
  mergeBranch,
  pruneWorktrees,
  removeWorktree,
  worktreeGitState,
} from "./git";
import {
  loadWorktrees,
  removeWorktreeRecord,
  saveWorktree,
  type WorktreeRecord,
  worktreePathFor,
  worktreesForRepo,
} from "./registry";

/**
 * Orchestrates the Trevor-managed worktree lifecycle (D-091) over the pure registry + git
 * layers: it builds the switcher read model, creates/removes worktrees, resolves a switch target,
 * reconciles stale entries, and runs the merge-back/diff inspection. Every external dependency -
 * filesystem, git, clock, id minting, path abbreviation - is injected, so the orchestration is
 * unit-tested with in-memory fakes and never touches a real repo in the unit tier.
 */
export interface WorktreeManagerDeps {
  readonly fs: import("./registry").WorktreeFs;
  readonly home: string;
  /** A git runner bound to a given directory (the base repo or a worktree). */
  readonly gitRunnerFor: (cwd: string) => GitRunner;
  /** Display abbreviation for a path (e.g. `~/dev/...`); identity paths stay absolute. */
  readonly abbrev: (path: string) => string;
  /** Canonicalizes a path for stable base-repo identity; node uses realpath, tests can use identity. */
  readonly realpath: (path: string) => string;
  readonly now: () => string;
  readonly genId: () => string;
}

/** The base-repo context a summary/switch is computed against. */
export interface WorktreeContext {
  /** Canonical base repo root - the stable identity + grouping key. */
  readonly baseRepo: string;
  readonly baseRepoName: string;
  /** The base-repo checkout path (the baseline row). */
  readonly basePath: string;
  /** The durable session bound to the baseline checkout. */
  readonly baselineSessionId: string;
  /** The host's current cwd, to mark the active row. */
  readonly currentPath: string;
}

export type CreateResult =
  | { readonly ok: true; readonly record: WorktreeRecord }
  | { readonly ok: false; readonly error: string };

export type SwitchTarget =
  | { readonly ok: true; readonly path: string; readonly sessionId: string }
  | { readonly ok: false; readonly error: string };

const BASELINE_ID = "baseline";

export class WorktreeManager {
  constructor(private readonly deps: WorktreeManagerDeps) {}

  /**
   * Resolves the worktree context for a cwd: the canonical base-repo identity, baseline session, and
   * current path. Null when cwd is not inside a git repository.
   */
  contextFor(cwd: string): WorktreeContext | null {
    const mainRoot = mainWorktreeRoot(this.deps.gitRunnerFor(cwd));
    if (!mainRoot) {
      return null;
    }
    const baseRepo = this.deps.realpath(mainRoot);
    return {
      baseRepo,
      baseRepoName: basename(baseRepo),
      basePath: mainRoot,
      baselineSessionId: projectSessionId(baseRepo),
      currentPath: cwd,
    };
  }

  /**
   * The switcher read model: the baseline checkout row first, then each active worktree for the
   * base repo. Git state (dirty/ahead/behind/conflict) is read per row from its own directory; a
   * worktree whose directory is gone is flagged `missing` (and not git-read), so a stale entry
   * shows as a repair row rather than throwing.
   */
  summaries(cwd: string): WorktreeSummary[] {
    const ctx = this.contextFor(cwd);
    if (!ctx) {
      return [];
    }
    const baseState = worktreeGitState(this.deps.gitRunnerFor(ctx.basePath));
    const baseline: WorktreeSummary = {
      id: BASELINE_ID,
      baseRepo: ctx.baseRepo,
      baseRepoName: ctx.baseRepoName,
      branch: baseState.git?.branch ?? baseState.git?.detached ?? "(detached)",
      path: this.deps.abbrev(ctx.basePath),
      sessionId: ctx.baselineSessionId,
      dirty: baseState.git?.dirty ?? false,
      ahead: baseState.git?.ahead ?? 0,
      behind: baseState.git?.behind ?? 0,
      conflict: baseState.conflict,
      detached: baseState.git?.branch == null && baseState.git?.detached != null,
      current: ctx.currentPath === ctx.basePath,
      baseline: true,
      missing: false,
    };

    const managed = worktreesForRepo(this.deps.fs, this.deps.home, ctx.baseRepo).map((view) => {
      if (view.missing) {
        return {
          id: view.id,
          baseRepo: view.baseRepo,
          baseRepoName: view.baseRepoName,
          branch: view.branch,
          path: this.deps.abbrev(view.worktreePath),
          sessionId: view.sessionId,
          dirty: false,
          ahead: 0,
          behind: 0,
          conflict: false,
          detached: false,
          current: false,
          baseline: false,
          missing: true,
        } satisfies WorktreeSummary;
      }
      const state = worktreeGitState(this.deps.gitRunnerFor(view.worktreePath));
      return {
        id: view.id,
        baseRepo: view.baseRepo,
        baseRepoName: view.baseRepoName,
        branch: state.git?.branch ?? view.branch,
        path: this.deps.abbrev(view.worktreePath),
        sessionId: view.sessionId,
        dirty: state.git?.dirty ?? false,
        ahead: state.git?.ahead ?? 0,
        behind: state.git?.behind ?? 0,
        conflict: state.conflict,
        detached: state.git?.branch == null && state.git?.detached != null,
        current: ctx.currentPath === view.worktreePath,
        baseline: false,
        missing: false,
      } satisfies WorktreeSummary;
    });

    return [baseline, ...managed];
  }

  /**
   * Creates a managed worktree for `branch` cut from `baseRef`, records it, and binds it to
   * `sessionId`. The path is the grouped, hashed, slugged layout; a git failure (branch exists,
   * path taken) returns a typed error and records nothing.
   */
  create(input: {
    readonly baseRepo: string;
    readonly baseRepoName: string;
    readonly basePath: string;
    readonly branch: string;
    readonly baseRef: string;
    readonly sessionId: string;
  }): CreateResult {
    const id = this.deps.genId();
    const worktreePath = worktreePathFor(this.deps.home, input.baseRepo, input.branch, id);
    const added = addWorktree(
      this.deps.gitRunnerFor(input.basePath),
      worktreePath,
      input.branch,
      input.baseRef,
    );
    if (!added.ok) {
      return added;
    }
    const baseCommit = headCommit(this.deps.gitRunnerFor(worktreePath)) ?? input.baseRef;
    const at = this.deps.now();
    const record: WorktreeRecord = {
      id,
      baseRepo: input.baseRepo,
      baseRepoName: input.baseRepoName,
      worktreePath,
      branch: input.branch,
      baseCommit,
      currentCommit: baseCommit,
      sessionId: input.sessionId,
      createdAt: at,
      updatedAt: at,
      status: "active",
    };
    saveWorktree(this.deps.fs, this.deps.home, record);
    return { ok: true, record };
  }

  /**
   * Creates a managed worktree from the caller's cwd. The manager resolves the base repo and durable
   * worktree session id internally, so command handlers do not need to understand WorktreeContext.
   */
  createFromCwd(input: {
    readonly cwd: string;
    readonly branch: string;
    readonly baseRef: string;
  }): CreateResult {
    const ctx = this.contextFor(input.cwd);
    if (!ctx) {
      return { ok: false, error: "Not a git repository." };
    }
    return this.create({
      baseRepo: ctx.baseRepo,
      baseRepoName: ctx.baseRepoName,
      basePath: ctx.basePath,
      branch: input.branch,
      baseRef: input.baseRef,
      sessionId: projectSessionId(`${ctx.baseRepo}#${input.branch}`),
    });
  }

  /**
   * Resolves a row id to the cwd + session a switch should target. The baseline row returns the
   * base checkout; a managed id returns its path/session, or a blocked/repair error when its
   * directory is gone (never a silent fallback to the baseline).
   */
  resolveSwitch(id: string, cwd: string): SwitchTarget {
    const ctx = this.contextFor(cwd);
    if (!ctx) {
      return { ok: false, error: "Not a git repository." };
    }
    if (id === BASELINE_ID) {
      return { ok: true, path: ctx.basePath, sessionId: ctx.baselineSessionId };
    }
    const record = loadWorktrees(this.deps.fs, this.deps.home)[id];
    if (record?.status !== "active") {
      return { ok: false, error: `unknown worktree: ${id}` };
    }
    if (!this.deps.fs.exists(record.worktreePath)) {
      return {
        ok: false,
        error: `worktree path is missing (needs repair): ${record.worktreePath}`,
      };
    }
    return { ok: true, path: record.worktreePath, sessionId: record.sessionId };
  }

  /**
   * Removes a worktree's directory + record. Without `force`, a dirty, conflicted, or unpushed
   * (ahead-of-upstream) worktree is refused with a typed error - the confirmation gate that keeps a
   * destructive cleanup from silently discarding work. `force` skips the gate.
   */
  remove(id: string, cwd: string, force: boolean): GitResult {
    const ctx = this.contextFor(cwd);
    if (!ctx) {
      return { ok: false, error: "Not a git repository." };
    }
    const record = loadWorktrees(this.deps.fs, this.deps.home)[id];
    if (!record) {
      return { ok: false, error: `unknown worktree: ${id}` };
    }
    if (!force && this.deps.fs.exists(record.worktreePath)) {
      const state = worktreeGitState(this.deps.gitRunnerFor(record.worktreePath));
      if (state.git?.dirty || state.conflict || (state.git?.ahead ?? 0) > 0) {
        return {
          ok: false,
          error: "worktree has uncommitted/unpushed/conflicted changes - confirm to force-delete",
        };
      }
    }
    const removed = removeWorktree(
      this.deps.gitRunnerFor(ctx.basePath),
      record.worktreePath,
      force,
    );
    if (!removed.ok) {
      return removed;
    }
    removeWorktreeRecord(this.deps.fs, this.deps.home, id);
    return { ok: true };
  }

  /**
   * Reconciles the registry against the filesystem: every active record whose directory is gone is
   * dropped and its git admin entry pruned, so a worktree deleted out-of-band doesn't linger. Returns
   * the ids that were reconciled away.
   */
  reconcile(cwd: string): string[] {
    const ctx = this.contextFor(cwd);
    if (!ctx) {
      return [];
    }
    const reconciled: string[] = [];
    for (const record of Object.values(loadWorktrees(this.deps.fs, this.deps.home))) {
      if (record.status === "active" && !this.deps.fs.exists(record.worktreePath)) {
        removeWorktreeRecord(this.deps.fs, this.deps.home, record.id);
        reconciled.push(record.id);
      }
    }
    if (reconciled.length > 0) {
      pruneWorktrees(this.deps.gitRunnerFor(ctx.basePath));
    }
    return reconciled;
  }

  /** Merges a worktree's branch back into the base checkout's current branch (M5). */
  mergeBack(id: string, cwd: string): GitResult {
    const ctx = this.contextFor(cwd);
    if (!ctx) {
      return { ok: false, error: "Not a git repository." };
    }
    const record = loadWorktrees(this.deps.fs, this.deps.home)[id];
    if (!record) {
      return { ok: false, error: `unknown worktree: ${id}` };
    }
    return mergeBranch(this.deps.gitRunnerFor(ctx.basePath), record.branch);
  }

  /** A diff stat of a worktree's branch against the base ref (the inspect-before-merge view, M5). */
  diff(id: string, cwd: string, baseRef: string): string {
    const ctx = this.contextFor(cwd);
    if (!ctx) {
      return "";
    }
    const record = loadWorktrees(this.deps.fs, this.deps.home)[id];
    if (!record) {
      return "";
    }
    return diffStat(this.deps.gitRunnerFor(ctx.basePath), baseRef, record.branch);
  }
}
