import { dirname, resolve, sep } from "node:path";
import { WORKSPACE_ROOT } from "@host/boot/paths";
import {
  AGENTS_FILE,
  type ContextReport,
  type ContextRuleSource,
  type ContextScope,
  collectEagerSources,
  readAgentsFile,
  renderContext,
  SCOPE_PRECEDENCE,
} from "./agents-md";
import { RuleCollector, type TrevorRuleSource } from "./rules";

/**
 * Session-scoped AGENTS.md context (D-080), the live counterpart to the pure reader. It owns the one
 * piece of state the reader cannot: the LAZY set of below-cwd AGENTS.md files discovered as the agent
 * touches files (Claude Code's lazy model). Like the task checklist, the full context is re-rendered
 * every turn from this registry, so it survives compaction (D-040) - the eager up-tree is re-read from
 * disk each render, and the accumulated lazy set is re-injected. `/clear` resets it.
 *
 * A single module instance mirrors `taskRegistry`: the host is one session per process.
 *
 * Responsible for: the session's live context state - the lazy below-cwd AGENTS.md + rules sets.
 * Not for: reading/rendering AGENTS.md itself - the pure core lives in agents-md.ts.
 */
export class ContextRegistry {
  /** Below-cwd AGENTS.md that have been lazily loaded, keyed by their directory (so each loads once). */
  private lazy = new Map<string, ContextScope>();
  /** Scoped .belay/rules loaded after matching file access, keyed by rule path. */
  private lazyRules = new Map<string, TrevorRuleSource>();
  /** Directories already checked for a below-cwd AGENTS.md (present or not), so a re-touch never re-stats. */
  private scanned = new Set<string>();
  /** The cached `.belay/rules` collector for the current cwd. Building one walks the rules tree, so it
   *  is reused across file touches + the per-turn report and only rebuilt on a cwd change or `reset()`. */
  private rules: { cwd: string; collector: RuleCollector } | null = null;

  /** The cached rule collector for `cwd`, rebuilt (re-walked) only when cwd changes or after reset(). */
  private rulesFor(cwd: string): RuleCollector {
    if (!this.rules || this.rules.cwd !== cwd) {
      this.rules = { cwd, collector: new RuleCollector(cwd) };
    }
    return this.rules.collector;
  }

  /** True when `child` is `root` or sits inside it. */
  private static within(child: string, root: string): boolean {
    return child === root || child.startsWith(root + sep);
  }

  /**
   * The directories strictly BELOW `cwd` on the path to `absFile`, top-most (just under cwd) first and
   * the file's own directory last. Empty when the file is in cwd itself (eager covers it) or not below
   * cwd at all (the eager up-tree already covers at/above cwd).
   */
  private static dirsBelowCwd(absFile: string, cwd: string): string[] {
    const base = resolve(cwd);
    const fileDir = dirname(resolve(absFile));
    if (fileDir === base || !ContextRegistry.within(fileDir, base)) {
      return [];
    }
    const dirs: string[] = [];
    let dir = fileDir;
    while (dir !== base && ContextRegistry.within(dir, base)) {
      dirs.push(dir);
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    return dirs.reverse();
  }

  /**
   * M3 trigger: a file tool resolved `absFile`. Load every not-yet-loaded AGENTS.md between `cwd` and
   * the touched file (deduped), so a directory-scoped instruction reaches the model right after a file
   * in that subtree is read. No-op for a file at/above cwd (the eager scope already covers it).
   */
  noteFileAccess(absFile: string, cwd: string = process.cwd()): void {
    for (const dir of ContextRegistry.dirsBelowCwd(absFile, cwd)) {
      if (this.scanned.has(dir)) {
        continue;
      }
      this.scanned.add(dir);
      const content = readAgentsFile(resolve(dir, AGENTS_FILE));
      if (content !== null) {
        this.lazy.set(dir, {
          path: resolve(dir, AGENTS_FILE),
          scope: "below-cwd",
          content,
          bytes: Buffer.byteLength(content),
        });
      }
    }
    const rules = this.rulesFor(cwd);
    for (const rule of rules.scopedRulesForFile(absFile)) {
      this.lazyRules.set(rule.path, rule);
    }
  }

  /** The full context report - eager (re-read) + the lazy below-cwd set - for the prompt + /doctor. */
  report(cwd: string = process.cwd(), workspaceRoot: string = WORKSPACE_ROOT): ContextReport {
    const eager = collectEagerSources({ cwd, workspaceRoot });
    const rules = this.rulesFor(cwd);
    const alwaysRuleSources = rules.alwaysRules();
    const alwaysRules = alwaysRuleSources.map((rule) => rules.contextScope(rule, "belay-rule"));
    // Below-cwd is the MOST specific, so it sits last (highest precedence); sort parent-before-child.
    const lazy = [...this.lazy.values()].sort((a, b) => a.path.localeCompare(b.path));
    const lazyRuleSources = [...this.lazyRules.values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    const lazyRules = lazyRuleSources.map((rule) => rules.contextScope(rule, "below-cwd-rule"));
    const ruleSources: ContextRuleSource[] = [
      ...alwaysRuleSources.map((rule) => rules.reportSource(rule)),
      ...lazyRuleSources.map((rule) => rules.reportSource(rule)),
    ];
    // Order by the owned scope-precedence rank (stable) instead of trusting concatenation order, so a
    // new band slots in by its declared rank and the comment-vs-code ordering can't drift.
    const ordered = [...eager, ...alwaysRules, ...lazy, ...lazyRules].sort(
      (a, b) => SCOPE_PRECEDENCE[a.scope] - SCOPE_PRECEDENCE[b.scope],
    );
    return renderContext(ordered, undefined, ruleSources);
  }

  /** The prompt block (eager + lazy), or "" when nothing is ingested. Re-rendered every turn. */
  renderForPrompt(cwd?: string, workspaceRoot?: string): string {
    return this.report(cwd, workspaceRoot).text;
  }

  /** Drops the lazy set (a `/clear` resets the baseline, so below-cwd context starts fresh too). */
  reset(): void {
    this.lazy.clear();
    this.lazyRules.clear();
    this.scanned.clear();
    this.rules = null;
  }
}

/** The session's AGENTS.md context registry (one per host process, like `taskRegistry`). */
export const contextRegistry = new ContextRegistry();
