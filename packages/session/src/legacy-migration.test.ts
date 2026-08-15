import assert from "node:assert/strict";
import { test } from "vitest";
import {
  executeLegacyMigration,
  type MigrationArtifact,
  type MigrationFs,
  type MigrationPlan,
  planLegacyMigration,
} from "./legacy-migration";

const HOME = "/Users/kevin";
const LEGACY_DB = "/Users/kevin/.belay_legacy/sessions.db";
const LEGACY_BLOBS = "/Users/kevin/.belay_legacy/blobs";
const TARGET_DB = "/Users/kevin/.local/state/belay/sessions.db";

const probe = (...existing: string[]) => ({ exists: (path: string) => existing.includes(path) });

function statusOf(plan: MigrationPlan, artifact: MigrationArtifact): string {
  const action = plan.actions.find((entry) => entry.artifact === artifact);
  assert.ok(action, `missing action for ${artifact}`);
  return action.status;
}

test("no legacy data: both artifacts skip and nothing migrates", () => {
  const plan = planLegacyMigration(probe(), {}, HOME);
  assert.equal(statusOf(plan, "sessions-db"), "skip-no-legacy");
  assert.equal(statusOf(plan, "blobs"), "skip-no-legacy");
  assert.equal(plan.hasLegacyData, false);
  assert.equal(plan.willMigrate, false);
});

test("legacy DB only: the db migrates, blobs skip", () => {
  const plan = planLegacyMigration(probe(LEGACY_DB), {}, HOME);
  assert.equal(statusOf(plan, "sessions-db"), "migrate");
  assert.equal(statusOf(plan, "blobs"), "skip-no-legacy");
  assert.equal(plan.hasLegacyData, true);
  assert.equal(plan.willMigrate, true);
});

test("legacy blobs only: blobs migrate, the db skips", () => {
  const plan = planLegacyMigration(probe(LEGACY_BLOBS), {}, HOME);
  assert.equal(statusOf(plan, "blobs"), "migrate");
  assert.equal(statusOf(plan, "sessions-db"), "skip-no-legacy");
});

test("both present: both migrate, targeting the STATE home", () => {
  const plan = planLegacyMigration(probe(LEGACY_DB, LEGACY_BLOBS), {}, HOME);
  assert.equal(statusOf(plan, "sessions-db"), "migrate");
  assert.equal(statusOf(plan, "blobs"), "migrate");
  const dbAction = plan.actions.find((entry) => entry.artifact === "sessions-db");
  assert.equal(dbAction?.target, TARGET_DB);
});

test("explicit overrides bypass migration even when legacy data exists", () => {
  const plan = planLegacyMigration(
    probe(LEGACY_DB, LEGACY_BLOBS),
    { SESSION_STORE_DB: "/tmp/custom.db", BLOB_STORE_DIR: "/tmp/custom-blobs" },
    HOME,
  );
  assert.equal(statusOf(plan, "sessions-db"), "skip-overridden");
  assert.equal(statusOf(plan, "blobs"), "skip-overridden");
  assert.equal(plan.hasLegacyData, true, "legacy data is still detected");
  assert.equal(plan.willMigrate, false, "but nothing is migrated under an override");
});

test("already-migrated state (target exists) is left untouched", () => {
  const plan = planLegacyMigration(probe(LEGACY_DB, TARGET_DB), {}, HOME);
  assert.equal(statusOf(plan, "sessions-db"), "skip-target-exists");
});

function fakeFs(existing: string[]): MigrationFs & { copied: string[]; removed: string[] } {
  const present = new Set(existing);
  const copied: string[] = [];
  const removed: string[] = [];
  return {
    copied,
    removed,
    exists: (path) => present.has(path),
    copy: (source, target) => {
      copied.push(`${source}=>${target}`);
      present.add(target);
    },
    remove: (path) => {
      removed.push(path);
      present.delete(path);
    },
  };
}

test("executor copies a migrate action and leaves the legacy source intact", () => {
  const plan = planLegacyMigration(probe(LEGACY_DB), {}, HOME);
  const fs = fakeFs([LEGACY_DB]);
  const outcomes = executeLegacyMigration(plan, fs);
  assert.equal(outcomes.find((o) => o.artifact === "sessions-db")?.status, "migrated");
  assert.deepEqual(fs.copied, [`${LEGACY_DB}=>${TARGET_DB}`]);
  assert.ok(fs.exists(LEGACY_DB), "legacy source remains as the backup");
});

test("executor rolls back a partial copy failure, removing the partial target", () => {
  const plan = planLegacyMigration(probe(LEGACY_DB), {}, HOME);
  const fs = fakeFs([LEGACY_DB]);
  fs.copy = () => {
    throw new Error("disk full");
  };
  const outcomes = executeLegacyMigration(plan, fs);
  const outcome = outcomes.find((o) => o.artifact === "sessions-db");
  assert.equal(outcome?.status, "rolled-back");
  assert.match(outcome?.reason ?? "", /disk full/);
  assert.deepEqual(fs.removed, [TARGET_DB]);
});

test("executor skips when the target appears between planning and execution", () => {
  const plan = planLegacyMigration(probe(LEGACY_DB), {}, HOME);
  const fs = fakeFs([LEGACY_DB, TARGET_DB]);
  const outcomes = executeLegacyMigration(plan, fs);
  assert.equal(outcomes.find((o) => o.artifact === "sessions-db")?.status, "skipped");
  assert.deepEqual(fs.copied, []);
});
