import { cpSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type BelayPathEnv, LEGACY_BELAY_DIRNAME, resolveBelayStateHome } from "./node-paths";

/**
 * Legacy `~/.belay_legacy` detection and forward-migration planning (D-009). The service-default cutover to
 * the STATE home already shipped, so this is NOT a default-changing path: it detects leftover
 * pre-XDG-split data and plans an explicit, idempotent, backup-safe copy forward. The planner is pure
 * over an injected existence probe; the small executor copies (never moves) so `~/.belay_legacy` stays intact
 * as the backup and a partial copy rolls its target back.
 */

export type MigrationArtifact = "sessions-db" | "blobs";

/** Why an artifact will or will not be copied forward. */
export type MigrationStatus =
  | "migrate"
  | "skip-no-legacy"
  | "skip-target-exists"
  | "skip-overridden";

export interface MigrationAction {
  readonly artifact: MigrationArtifact;
  /** Legacy source under `~/.belay_legacy`. Always left intact (it is the backup). */
  readonly source: string;
  /** Forward target under the STATE home. */
  readonly target: string;
  readonly status: MigrationStatus;
  readonly reason: string;
}

export interface MigrationPlan {
  readonly actions: readonly MigrationAction[];
  /** True when any legacy artifact exists on disk (whether or not it will be migrated). */
  readonly hasLegacyData: boolean;
  /** True when at least one action will copy data forward. */
  readonly willMigrate: boolean;
  readonly rollbackNotes: string;
}

interface ArtifactSpec {
  readonly artifact: MigrationArtifact;
  readonly legacyName: string;
  readonly stateName: string;
  readonly overrideEnv: string;
}

const ARTIFACTS: readonly ArtifactSpec[] = [
  {
    artifact: "sessions-db",
    legacyName: "sessions.db",
    stateName: "sessions.db",
    overrideEnv: "SESSION_STORE_DB",
  },
  { artifact: "blobs", legacyName: "blobs", stateName: "blobs", overrideEnv: "BLOB_STORE_DIR" },
];

/** The existence check the pure planner depends on, injectable for deterministic tests. */
export interface MigrationProbe {
  exists(path: string): boolean;
}

/**
 * Plans the legacy migration without touching disk. Per artifact: an explicit `SESSION_STORE_DB` /
 * `BLOB_STORE_DIR` override bypasses migration; absent legacy data is a no-op; an already-present
 * target is left untouched (cannot silently overwrite live service data); otherwise the legacy data is
 * copied forward.
 */
export function planLegacyMigration(
  probe: MigrationProbe,
  env: BelayPathEnv = process.env,
  home: string = homedir(),
): MigrationPlan {
  const legacyRoot = join(home, LEGACY_BELAY_DIRNAME);
  const stateHome = resolveBelayStateHome(env, home);

  let hasLegacyData = false;

  const actions = ARTIFACTS.map((spec): MigrationAction => {
    const source = join(legacyRoot, spec.legacyName);
    const target = join(stateHome, spec.stateName);
    const legacyExists = probe.exists(source);

    if (legacyExists) {
      hasLegacyData = true;
    }

    if (env[spec.overrideEnv]) {
      return {
        artifact: spec.artifact,
        source,
        target,
        status: "skip-overridden",
        reason: `${spec.overrideEnv} is set; an explicit override bypasses migration`,
      };
    }

    if (!legacyExists) {
      return {
        artifact: spec.artifact,
        source,
        target,
        status: "skip-no-legacy",
        reason: "no legacy data at the source",
      };
    }

    if (probe.exists(target)) {
      return {
        artifact: spec.artifact,
        source,
        target,
        status: "skip-target-exists",
        reason: "target already exists; not overwriting current service data",
      };
    }

    return {
      artifact: spec.artifact,
      source,
      target,
      status: "migrate",
      reason: "legacy data present and target absent; copy forward (legacy left intact)",
    };
  });

  return {
    actions,
    hasLegacyData,
    willMigrate: actions.some((action) => action.status === "migrate"),
    rollbackNotes:
      "Migration copies (never moves) legacy data, so ~/.belay_legacy stays intact as the backup; rollback removes the copied target.",
  };
}

/** The filesystem operations the executor needs, injectable so tests never touch real disk. */
export interface MigrationFs extends MigrationProbe {
  copy(source: string, target: string): void;
  remove(path: string): void;
}

export type MigrationOutcomeStatus = "migrated" | "skipped" | "rolled-back";

export interface MigrationOutcome {
  readonly artifact: MigrationArtifact;
  readonly status: MigrationOutcomeStatus;
  readonly reason: string;
}

/**
 * Executes a plan's `migrate` actions. Re-checks the target immediately before copying (idempotency
 * against a target that appeared since planning), and on a partial copy failure removes the partial
 * target so `~/.belay_legacy` remains the intact source of truth.
 */
export function executeLegacyMigration(plan: MigrationPlan, fs: MigrationFs): MigrationOutcome[] {
  return plan.actions.map((action): MigrationOutcome => {
    if (action.status !== "migrate") {
      return { artifact: action.artifact, status: "skipped", reason: action.reason };
    }

    if (fs.exists(action.target)) {
      return {
        artifact: action.artifact,
        status: "skipped",
        reason: "target appeared before copy; not overwriting",
      };
    }

    try {
      fs.copy(action.source, action.target);
      return { artifact: action.artifact, status: "migrated", reason: action.reason };
    } catch (error) {
      try {
        fs.remove(action.target);
      } catch {
        // best-effort rollback; ~/.belay_legacy is untouched regardless
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { artifact: action.artifact, status: "rolled-back", reason: `copy failed: ${detail}` };
    }
  });
}

/** The real, node-backed filesystem adapter for the executor. */
export const nodeMigrationFs: MigrationFs = {
  exists: (path) => existsSync(path),
  copy: (source, target) => cpSync(source, target, { recursive: true }),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};
