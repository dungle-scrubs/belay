import { events, type GitStatus, gitRefLabel } from "@belay/session";
import { abbrevHome, WORKSPACE_ROOT } from "@host/boot/paths";
import type { CommandRegistry } from "@host/commands/commands";
import { debugCommandSpecs } from "@host/commands/debug-commands";
import type { InternetMonitor } from "@host/connectivity/probe";
import { modelPrefs } from "@host/prefs/model-prefs-store";
import { vimEnabled } from "@host/prefs/vim-store";
import { supervisor } from "@host/processes/processes";
import type { CatalogSnapshot } from "@host/providers/catalog";
import { DEFAULT_PROVIDER, type ProviderRegistry } from "@host/providers/index";
import { describeAgent, discoverAgents } from "@host/subagents/discovery";
import { nodeGitRunner, readGitStatus } from "@host/worktrees/git-status";
import type { WorktreeManager } from "@host/worktrees/manager";
import type { EmitEvent } from "./services";

/**
 * The host presence surface, extracted from main.ts (plan 22.3): main.ts constructs
 * {@link makePresence} once over its live providers/commands/catalog/debug state and keeps
 * dispatching from refreshCatalog, the command lanes, the shell lane, and the doctor facts under
 * the same local names; `supervisor.onChange = announceOnline` stays wired in main.ts.
 *
 * Responsible for: the git/worktree projections the announcement (and /doctor) reads, and building
 * + emitting the idempotent host.online snapshot.
 * Not for: WHEN to announce (main.ts's go-live/leader/command call sites own that), or the lease
 * heartbeat/hello presence signals (session/lease.ts + boot/leadership.ts).
 */

/** The live main.ts state the announcement snapshots - registries, monitors, and mutable getters. */
export interface PresenceDeps {
  /** The registered providers: keys, default, and each one's model descriptor. */
  readonly providers: ProviderRegistry;
  /** The immediate-command registry: its specs ride every announcement. */
  readonly commands: Pick<CommandRegistry, "specs">;
  /** The runtime debug flag (main.ts's mutable `debugMode`): adds the debug command set. */
  debugMode(): boolean;
  /** The Belay-managed worktree manager (D-091): the base repo's switcher rows. */
  readonly worktrees: Pick<WorktreeManager, "summaries">;
  /** The internet monitor (D-060): the latest snapshot rides every announcement. */
  readonly internet: Pick<InternetMonitor, "current">;
  /** The host-owned model source + catalog read model (main.ts's mutable `catalog`). */
  catalog(): CatalogSnapshot;
  /** This host instance's id, so clients can tell hosts apart. */
  readonly instanceId: string;
  /** Publish one host-authored event to the durable log (main.ts's emit). */
  readonly emit: EmitEvent;
}

/** Builds the presence projections + announcement over the host's live state; main.ts wires it once. */
export function makePresence(deps: PresenceDeps) {
  const { providers, commands, debugMode, worktrees, internet, catalog, instanceId, emit } = deps;

  /**
   * Reads the host cwd's structured git status (D-088) plus a back-compat `branch` string
   * derived from it (branch name, or `detached <sha>` when HEAD is detached). A non-git cwd
   * yields both undefined - the status is omitted rather than reported as an empty repo.
   */
  function currentGit(): { git: GitStatus | undefined; branch: string | undefined } {
    const status = readGitStatus(nodeGitRunner(process.cwd()));
    if (!status) {
      return { git: undefined, branch: undefined };
    }
    return { git: status, branch: gitRefLabel(status) ?? undefined };
  }

  /** The managed worktrees for the host's current base repo (empty when cwd is not a git repo). */
  function currentWorktrees(): ReturnType<typeof worktrees.summaries> {
    try {
      return worktrees.summaries(process.cwd());
    } catch {
      return [];
    }
  }

  /**
   * Builds and emits host.online with a freshly-read git status. Idempotent + latching, so
   * it doubles as the git-status refresh after a host-owned operation that can change the
   * repository (a `!` shell command); a `/cd` or `/clear` instead spawns a new host that
   * re-runs goLive in the new cwd.
   */
  function announceOnline(): void {
    const { git, branch } = currentGit();
    emit(
      events.hostOnline({
        // Per-provider model id + thinking options so the browser can render the right
        // reasoning control (none / binary / graduated) for whichever provider is chosen.
        // Each provider describes its own descriptor, so the announcement can't drift from
        // the Provider interface.
        providers: Object.keys(providers),
        default: DEFAULT_PROVIDER,
        models: Object.fromEntries(
          Object.entries(providers).map(([key, provider]) => [key, provider.describe()]),
        ),
        instanceId,
        ...(branch ? { branch } : {}),
        ...(git ? { git } : {}),
        cwd: abbrevHome(process.cwd()),
        workspace: abbrevHome(WORKSPACE_ROOT),
        // The immediate-command inventory, so the browser knows which slashes route
        // to the host's command lane (and can drive a slash menu). Debug-mode adds /restart
        // (and friends) to this set; toggling /debug re-announces with the set updated.
        commands: [...commands.specs, ...debugCommandSpecs(debugMode())],
        // The discovered subagents (D-045), so the model picks one to delegate to by description.
        agents: discoverAgents().map(describeAgent),
        // The managed worktrees for this base repo (D-091), so the browser's switcher renders
        // without reading local state.
        worktrees: currentWorktrees(),
        // The latest internet snapshot (D-060), so a joining client sees connectivity without waiting
        // for the next probe transition.
        internet: internet.current(),
        // The host-owned model sources + per-source catalog (D-065): the provider/runtime/subscription
        // summaries with auth state, and each configured source's live model list. Empty until the
        // first async load completes (then a re-announce fills them in).
        sources: catalog().sources,
        catalog: catalog().catalogBySource,
        // The host-owned Vim-mode prompt preference (plan 06), so the web gates its opt-in composer
        // motions on this machine's vim.json config rather than per-tab browser state.
        vimEnabled: vimEnabled(),
        // The host-owned model preference (plan 51): the durable default + favorites, so a fresh session
        // starts on the user's default (not qwen) and the chooser reads favorites from here rather than
        // a per-browser localStorage blob. Read from the store's cache (cleared on a set-default /
        // toggle-favorite, which re-announces).
        modelPrefs: modelPrefs(),
        // The tracked background jobs (plan 09): promoted bash/shell commands + `process` jobs, so the
        // support panel renders them. The supervisor re-announces on every job change (main.ts wires
        // supervisor.onChange to this function).
        jobs: supervisor.snapshots(),
      }),
    ).catch(() => {});
  }

  return { currentGit, currentWorktrees, announceOnline };
}
