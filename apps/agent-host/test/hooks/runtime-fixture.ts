import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  approveHook,
  EMPTY_HOOK_APPROVALS,
  type HookApprovalsState,
  hookApprovalKey,
  saveHookApprovals,
} from "@host/hooks/approval";
import type { HookSource } from "@host/hooks/config";
import { discoverHooks } from "@host/hooks/discovery";
import {
  createHooksRuntime,
  type HooksRuntime,
  type PreToolUsePayload,
  type StopPayload,
} from "@host/hooks/runtime";
import { computeHookTrustFingerprint } from "@host/hooks/trust";
import { HOOK_FIXTURE_COMMAND, hookFixtureArgs } from "./fixture-config";

/**
 * Shared temp-config builder for the hooks RUNTIME suites (plan 25 M5): materializes real
 * project/user hooks.json files over ./fixture-hook, grants real approvals (computed with the
 * same trust fingerprints the runtime evaluates, under the same workspace-scoped keys), and
 * returns a `createHooksRuntime` bound to those roots - so dispatch tests exercise the
 * discovery -> trust -> approval -> execution pipeline end to end on disk, exactly as a
 * configured host would.
 *
 * Responsible for: the on-disk hooks-runtime test harness (config files, approvals, payloads).
 * Not for: fixture child behavior (./fixture-hook) or the launch recipe (./fixture-config).
 */

/** One hook entry to materialize: fixture mode + flags, plus config/approval knobs. */
export interface FixtureHookSpec {
  readonly id: string;
  readonly mode: string;
  readonly flags?: readonly string[];
  /** Config event; default "PreToolUse". */
  readonly event?: string;
  readonly enabled?: boolean;
  /** Whether to grant a real approval for the hook's current fingerprint; default true. */
  readonly approved?: boolean;
}

export interface HooksRuntimeHarness {
  readonly runtime: HooksRuntime;
  /** The workspace root the runtime is bound to (hook children run here). */
  readonly workspaceRoot: string;
  /** The approvals file the runtime reads (stat-guarded per dispatch). */
  readonly approvalsPath: string;
  /** The workspace-scoped approval key of a PROJECT hook (S1): `project:<workspace>:<id>`. */
  readonly projectKey: (id: string) => string;
  /** The approval key of a USER hook: `user:<id>`. */
  readonly userKey: (id: string) => string;
  /** A scratch path inside the harness dir (e.g. a record-file or marker target). */
  readonly scratchPath: (name: string) => string;
  readonly cleanup: () => void;
}

function hooksJson(specs: readonly FixtureHookSpec[]): string {
  const hooks: Record<string, unknown> = {};
  for (const spec of specs) {
    hooks[spec.id] = {
      event: spec.event ?? "PreToolUse",
      command: HOOK_FIXTURE_COMMAND,
      args: hookFixtureArgs(spec.mode, spec.flags ?? []),
      ...(spec.enabled === false ? { enabled: false } : {}),
    };
  }
  return JSON.stringify({ hooks });
}

/** Hook specs, or a builder over the harness's scratch-path minter (so a spec's flags can name
 *  record/marker files inside the harness dir before the harness exists). */
export type FixtureHookSpecs =
  | readonly FixtureHookSpec[]
  | ((scratch: (name: string) => string) => readonly FixtureHookSpec[]);

export interface HarnessOptions {
  /** Files (relative path -> contents) materialized under the WORKSPACE root before approvals
   *  are computed, so a hook whose args reference them is approved over their initial bytes. */
  readonly workspaceFiles?: Readonly<Record<string, string>>;
}

/**
 * Builds a runtime over real temp hooks.json roots. Approvals are granted against the SAME
 * fingerprints the runtime computes (project hooks anchored at the workspace root, user hooks
 * at the user config dir) under the SAME workspace-scoped keys, so `approved: true` hooks
 * actually execute.
 */
export function hooksRuntimeHarness(
  projectSpecs: FixtureHookSpecs,
  userSpecs: FixtureHookSpecs = [],
  options: HarnessOptions = {},
): HooksRuntimeHarness {
  const root = mkdtempSync(join(tmpdir(), "trevor-hooks-rt-"));
  const scratchPath = (name: string): string => join(root, name);
  const project = typeof projectSpecs === "function" ? projectSpecs(scratchPath) : projectSpecs;
  const user = typeof userSpecs === "function" ? userSpecs(scratchPath) : userSpecs;
  const workspaceRoot = join(root, "workspace");
  const userConfigDir = join(root, "user-home");
  mkdirSync(join(workspaceRoot, ".trevor"), { recursive: true });
  mkdirSync(userConfigDir, { recursive: true });

  const projectHooksPath = join(workspaceRoot, ".trevor", "hooks.json");
  const userHooksPath = join(userConfigDir, "hooks.json");
  const approvalsPath = join(root, "state", "hook-approvals.json");
  writeFileSync(projectHooksPath, hooksJson(project));
  writeFileSync(userHooksPath, hooksJson(user));
  for (const [relative, contents] of Object.entries(options.workspaceFiles ?? {})) {
    const target = join(workspaceRoot, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }

  const approvedIds = new Set(
    [
      ...project.map((spec) => (spec.approved !== false ? `project:${spec.id}` : null)),
      ...user.map((spec) => (spec.approved !== false ? `user:${spec.id}` : null)),
    ].filter((key): key is string => key !== null),
  );
  const report = discoverHooks({ projectHooksPath, userHooksPath });
  let approvals: HookApprovalsState = EMPTY_HOOK_APPROVALS;
  for (const hook of report.hooks) {
    if (!approvedIds.has(`${hook.source}:${hook.id}`)) {
      continue;
    }
    const baseDir = baseDirFor(hook.source, workspaceRoot, userConfigDir);
    approvals = approveHook(
      approvals,
      hookApprovalKey(hook, workspaceRoot),
      computeHookTrustFingerprint(hook, baseDir).hash,
    );
  }
  saveHookApprovals(approvals, approvalsPath);

  return {
    runtime: createHooksRuntime({
      roots: { projectHooksPath, userHooksPath },
      approvalsPath,
      workspaceRoot,
      userConfigDir,
      // Isolate the M10 legacy HOOK.md scan from the developer's real ~/.trevor/hooks.
      legacyUserHooksDir: join(root, "legacy-user-hooks"),
    }),
    workspaceRoot,
    approvalsPath,
    projectKey: (id) => hookApprovalKey({ source: "project", id }, workspaceRoot),
    userKey: (id) => hookApprovalKey({ source: "user", id }, workspaceRoot),
    scratchPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function baseDirFor(source: HookSource, workspaceRoot: string, userConfigDir: string): string {
  return source === "project" ? workspaceRoot : userConfigDir;
}

/** A complete PreToolUse payload with overridable fields, for dispatch-level tests. */
export function preToolUsePayload(overrides: Partial<PreToolUsePayload> = {}): PreToolUsePayload {
  return {
    event: "PreToolUse",
    sessionId: "s-hooks-test",
    runId: "run-hooks-1",
    turnId: "run-hooks-1",
    cwd: "/tmp",
    callerKind: "main",
    toolName: "bash",
    toolInput: { command: "echo hi" },
    toolMetadata: { readOnly: false },
    ...overrides,
  };
}

/** A complete Stop payload with overridable fields, for dispatch-level tests (25 M7). */
export function stopPayload(overrides: Partial<StopPayload> = {}): StopPayload {
  return {
    event: "Stop",
    sessionId: "s-hooks-test",
    runId: "run-hooks-1",
    turnId: "run-hooks-1",
    cwd: "/tmp",
    terminalReason: "completed",
    finalText: "The final answer.",
    toolSummary: [{ tool: "bash", count: 2 }],
    ...overrides,
  };
}
