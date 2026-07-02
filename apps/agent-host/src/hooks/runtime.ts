import { TREVOR_HOME, WORKSPACE_ROOT } from "@host/boot/paths";
import { debug, log, warn } from "@host/transport/log";
import {
  approvedHashFor,
  type HookApprovalsState,
  hookApprovalKey,
  hookApprovalsPath,
  loadHookApprovals,
} from "./approval";
import type { HookConfigIssue, HookDefinition, HookEvent, HookSource } from "./config";
import type { HookDecision, HookDecisionKind } from "./decision";
import {
  defaultHookDiscoveryRoots,
  discoverHooks,
  discoverLegacyHookFiles,
  type HookDiscoveryReport,
  type HookDiscoveryRoots,
  type LegacyHookFile,
} from "./discovery";
import { evaluateUpdatedInput } from "./input-policy";
import { redactHookText } from "./redact";
import {
  type HookDiagnosticOutcome,
  type HookDiagnosticReason,
  hookExecutionOutcome,
  hookTrustOutcome,
} from "./results";
import { type HookRunnerOptions, runHook } from "./runner";
import { createHookStats, type HookStatsEntry } from "./stats";
import { computeHookTrustFingerprint, evaluateHookTrust, type HookTrustStatus } from "./trust";

/**
 * The hooks RUNTIME (plan 25 M5/M7): the host-lifetime seam that composes discovery, trust
 * evaluation, the approval gate, execution, and per-hook stats into one dispatch surface, in
 * the mcp/lsp host-runtime tradition (construction touches nothing; discovery is lazy and
 * cached for the host's lifetime, approvals re-read per dispatch so a fresh grant takes effect
 * without a restart). Both dispatchers run every enabled, APPROVED hook of their event in
 * config order (project root before user root, D-001); the first blocking decision
 * short-circuits the rest (D-003), unapproved/changed/missing-script hooks contribute
 * diagnostics without ever executing (D-006), and every failure mode is a non-blocking
 * diagnostic (D-007) - dispatch itself NEVER rejects. `dispatchPreToolUse` allow decisions can
 * additionally carry bounded, attributed context notes and an allowlist-scoped input rewrite
 * (25 M6, D-003 - ./input-policy owns the table). `dispatchStop` reviews a finalizing turn
 * (D-004): its only blocking semantic is halt (a stray "deny" normalizes to halt rather than
 * minting a third finalization verb), its contexts are the one-pass continuation request (M8),
 * and `updatedInput` is ignored wholesale - a Stop hook rewrites nothing. Everything logged
 * here is redacted (D-009); transcript events are M9's, so callers get the outcome as data.
 *
 * Responsible for: the PreToolUse/Stop payload/outcome contracts and the discovery -> trust ->
 * approval -> execution -> outcome dispatch pipeline.
 * Not for: the host singleton (./host-runtime), loop-side enforcement of an outcome
 * (@host/agent/loop), the turn-finalization seam (@host/agent/turn), or per-module mechanics
 * (./discovery, ./trust, ./approval, ./runner).
 */

/** Who initiated the gated tool call: the main turn loop, a delegated subagent turn, or a
 *  restricted `/clip` turn. Derived from what each publishTurn call site knows. */
export type HookCallerKind = "main" | "subagent" | "clip";

/**
 * What a PreToolUse hook reads on stdin (D-003). `runId` is the host's per-turn correlation id;
 * `turnId` mirrors it because one run IS one turn in this host - the field exists so the payload
 * contract survives a future run/turn split without breaking hook scripts.
 */
export interface PreToolUsePayload {
  readonly event: "PreToolUse";
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly callerKind: HookCallerKind;
  readonly toolName: string;
  /** The tool call's parsed arguments (or the raw string when unparseable). */
  readonly toolInput: unknown;
  readonly toolMetadata: { readonly readOnly: boolean };
}

/** Why one hook contributed no usable effect: a run/trust diagnostic, or a rejected input
 *  rewrite (25 M6) - the hook spoke a decision but its updatedInput failed the allowlist. */
export type PreToolUseDiagnosticReason = HookDiagnosticReason | "updated_input_rejected";

/** One per-dispatch diagnostic: which hook, why it produced no usable effect, redacted detail. */
export interface PreToolUseDiagnostic {
  /** The hook's approval key, `<source>:<id>`. */
  readonly hook: string;
  readonly reason: PreToolUseDiagnosticReason;
  readonly detail: string;
}

/** One hook's bounded context note (25 M6), attributed so the model/transcript can cite it. */
export interface PreToolUseContext {
  /** The contributing hook's approval key, `<source>:<id>`. */
  readonly hook: string;
  /** Bounded at decision parse (MAX_HOOK_CONTEXT_CHARS). */
  readonly context: string;
}

/**
 * What one dispatch means to the tool boundary: the effective decision (the first blocking
 * deny/halt, else allow), the blocking hook + its reason when one fired, the bounded context
 * notes gathered from every decision that ran (25 M6), the merged allowlisted input rewrite
 * when one passed policy (25 M6, D-003), and every accumulated diagnostic. Plain data - the
 * loop applies it, M9 turns it into transcript events.
 */
export interface PreToolUseOutcome {
  readonly decision: HookDecisionKind;
  /** The blocking hook's approval key; absent when the dispatch allowed. */
  readonly hook?: string;
  /** The blocking hook's stated reason (bounded at parse); absent when none was given. */
  readonly reason?: string;
  /** Context notes in hook config order, including the blocking hook's own note. */
  readonly contexts: readonly PreToolUseContext[];
  /** The merged, allowlist-validated field rewrites (later hooks override the same field, in
   *  config order). Absent when no hook rewrote anything or every rewrite was rejected. The
   *  values are UNVALIDATED here - the tool's normal schema decode still applies (D-003). */
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  /** The approval keys of the hooks whose rewrites contributed to `updatedInput`, in config
   *  order (25 M9 attribution: the updated_input event names its author). Present exactly when
   *  `updatedInput` is. */
  readonly updatedInputHooks?: readonly string[];
  readonly diagnostics: readonly PreToolUseDiagnostic[];
}

/**
 * What a Stop hook reads on stdin (plan 25 M7, D-004): the finalizing run's identity plus the
 * terminal result it is reviewing. `terminalReason` is the turn's TurnStop cause when one fired
 * (e.g. "context_pressure", "hook_halt") or "completed" for an ordinary answer; `toolSummary`
 * is the compact per-tool accounting of what the turn ran (names + counts + touched paths when
 * cheaply derivable) - never raw arguments or outputs.
 */
export interface StopPayload {
  readonly event: "Stop";
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly cwd: string;
  /** The turn's terminal cause: the TurnStop cause when one fired, else "completed". */
  readonly terminalReason: string;
  /** The turn's final assistant text, as it would finalize. */
  readonly finalText: string;
  readonly toolSummary: readonly StopToolSummaryEntry[];
}

/** One tool's compact accounting in a Stop payload: call count + distinct touched paths. */
export interface StopToolSummaryEntry {
  readonly tool: string;
  readonly count: number;
  /** Distinct `path` arguments observed (capped); absent for path-less tools like bash. */
  readonly files?: readonly string[];
}

/** The only finalization decisions (D-004): finalize unchanged, or block with a visible reason. */
export type StopDecision = "allow" | "halt";

/** One hook's bounded continuation context (M8), attributed like {@link PreToolUseContext}. */
export interface StopContext {
  /** The contributing hook's approval key, `<source>:<id>`. */
  readonly hook: string;
  /** Bounded at decision parse (MAX_HOOK_CONTEXT_CHARS). */
  readonly context: string;
}

/** Why one Stop hook contributed no usable effect: a run/trust diagnostic, or a continuation
 *  request past the one-pass budget (25 M8) - the turn seam appends that one, not this module. */
export type StopDiagnosticReason = HookDiagnosticReason | "continuation_exhausted";

/** One per-dispatch Stop diagnostic: which hook, why it produced no usable effect. */
export interface StopDiagnostic {
  /** The hook's approval key, `<source>:<id>`. */
  readonly hook: string;
  readonly reason: StopDiagnosticReason;
  readonly detail: string;
}

/**
 * What one Stop dispatch means to the finalization seam (D-004): the effective decision (the
 * first blocking hook halts; a stray "deny" normalizes to halt), the blocking hook + reason
 * when one fired, the bounded context notes (the one-pass continuation request, M8), and every
 * accumulated diagnostic. Plain data - @host/agent/turn applies it, M9 turns it into events.
 * There is deliberately NO rewrite surface here: a Stop hook cannot mutate anything.
 */
export interface StopOutcome {
  readonly decision: StopDecision;
  /** The halting hook's approval key; absent when the dispatch allowed. */
  readonly hook?: string;
  /** The halting hook's stated reason (bounded at parse); absent when none was given. */
  readonly reason?: string;
  /** Context notes in hook config order, including the halting hook's own note. */
  readonly contexts: readonly StopContext[];
  readonly diagnostics: readonly StopDiagnostic[];
}

export interface HooksRuntimeOptions {
  /** The hooks.json roots (default: the workspace + user-global roots). */
  readonly roots?: HookDiscoveryRoots;
  /** The approvals file (default: the storage-inventory path). */
  readonly approvalsPath?: string;
  /** Trust anchor for project hooks + the hook child cwd (default WORKSPACE_ROOT). */
  readonly workspaceRoot?: string;
  /** Trust anchor for user hooks (default TREVOR_HOME). */
  readonly userConfigDir?: string;
  /** The V1 user hooks dir the legacy HOOK.md scan checks (M10); default `~/.trevor/hooks`.
   *  Injectable so tests never touch the real legacy home. */
  readonly legacyUserHooksDir?: string;
  /** Runner tunables passed through to every execution; injectable for tests. */
  readonly runnerOptions?: Omit<HookRunnerOptions, "cwd">;
}

/** One configured hook's doctor-facing status (M9): identity + freshly evaluated trust. */
export interface HookStatusEntry {
  /** The hook's approval key, `<source>:<id>`. */
  readonly key: string;
  readonly event: HookEvent;
  readonly source: HookSource;
  readonly enabled: boolean;
  readonly trust: HookTrustStatus;
}

/** The doctor-facing hooks picture (M9): configured hooks + config issues + legacy HOOK.md. */
export interface HooksStatusSnapshot {
  readonly hooks: readonly HookStatusEntry[];
  readonly issues: readonly HookConfigIssue[];
  /** Legacy V1 HOOK.md files found near the hook roots (M10) - reported, never executed. */
  readonly legacy: readonly LegacyHookFile[];
}

export interface HooksRuntime {
  /** Runs the PreToolUse gate for one tool call. Resolves ALWAYS - never rejects (D-007). */
  readonly dispatchPreToolUse: (payload: PreToolUsePayload) => Promise<PreToolUseOutcome>;
  /** Runs the Stop gate for one finalizing turn (M7). Resolves ALWAYS - never rejects (D-007). */
  readonly dispatchStop: (payload: StopPayload) => Promise<StopOutcome>;
  /** The per-hook run counters for Doctor (M9). */
  readonly statsSnapshot: () => readonly HookStatsEntry[];
  /** The cached discovery report (definitions + config issues) for Doctor (M9). */
  readonly discoveryReport: () => HookDiscoveryReport;
  /** The doctor-facing status picture (M9): every configured hook with its trust state,
   *  evaluated fresh (approvals + fingerprints re-read), plus config issues and legacy files. */
  readonly statusSnapshot: () => HooksStatusSnapshot;
}

/** One gated hook's result inside a dispatch: a (never-executed or failed) diagnostic, or the
 *  decision a successful run spoke. Shared by both dispatchers; each interprets the decision. */
type GatedHookRun =
  | HookDiagnosticOutcome
  | { readonly kind: "decision"; readonly decision: HookDecision; readonly durationMs: number };

/** Builds a hooks runtime bound to explicit roots/paths; production uses ./host-runtime. */
export function createHooksRuntime(options: HooksRuntimeOptions = {}): HooksRuntime {
  const roots = options.roots ?? defaultHookDiscoveryRoots();
  const approvalsPath = options.approvalsPath ?? hookApprovalsPath();
  const workspaceRoot = options.workspaceRoot ?? WORKSPACE_ROOT;
  const userConfigDir = options.userConfigDir ?? TREVOR_HOME;
  const stats = createHookStats();

  // Discovery is lazy and cached for the host's lifetime (the mcp-servers.json posture: config
  // is read at startup, not per call); approvals re-read per dispatch below, so approving a hook
  // takes effect on the next tool call without a host restart.
  let discovered: HookDiscoveryReport | undefined;
  const discovery = (): HookDiscoveryReport => {
    if (!discovered) {
      discovered = discoverHooks(roots);
      for (const issue of discovered.issues) {
        warn("hooks", "hooks.json issue", {
          hook: issue.hook,
          source: issue.source,
          kind: issue.kind,
          detail: issue.detail,
        });
      }
    }
    return discovered;
  };

  /** The trust anchor for a hook's relative script references (D-006). */
  const trustBaseDir = (hook: HookDefinition): string =>
    hook.source === "project" ? workspaceRoot : userConfigDir;

  // The shared per-hook gate for both dispatchers (M7): trust evaluation (D-006), execution,
  // stats, and the diagnostic/decision split (D-007). Throws only on an unexpected fault, which
  // each dispatcher folds into that hook's command_failed diagnostic - dispatch never rejects.
  const gateAndRun = async (
    hook: HookDefinition,
    key: string,
    approvals: HookApprovalsState,
    payload: unknown,
  ): Promise<GatedHookRun> => {
    const fingerprint = computeHookTrustFingerprint(hook, trustBaseDir(hook));
    const status = evaluateHookTrust(fingerprint, approvedHashFor(approvals, key));
    const trustDiagnostic = hookTrustOutcome(status);
    if (trustDiagnostic) {
      // The gate stays closed (D-006): report, never execute - and never block the caller.
      debug("hooks", "hook skipped", { hook: key, reason: trustDiagnostic.reason });
      return trustDiagnostic;
    }

    const execution = await runHook(hook, payload, {
      cwd: workspaceRoot,
      ...options.runnerOptions,
    });
    const outcome = hookExecutionOutcome(execution);
    stats.record(hook, execution, outcome);

    if (outcome.kind === "diagnostic") {
      warn("hooks", "hook diagnostic", {
        hook: key,
        reason: outcome.reason,
        detail: outcome.detail,
        ms: execution.durationMs,
      });
      return outcome;
    }
    return { kind: "decision", decision: outcome.decision, durationMs: execution.durationMs };
  };

  const dispatchPreToolUse = async (payload: PreToolUsePayload): Promise<PreToolUseOutcome> => {
    const hooks = discovery().hooks.filter((hook) => hook.event === "PreToolUse" && hook.enabled);
    if (hooks.length === 0) {
      return { decision: "allow", contexts: [], diagnostics: [] };
    }
    const approvals = loadHookApprovals(approvalsPath);
    const diagnostics: PreToolUseDiagnostic[] = [];
    const contexts: PreToolUseContext[] = [];
    // The merged allowlisted rewrites (25 M6): each passing hook's fields layer on in config
    // order, so a later hook overrides an earlier one field-by-field - the same last-writer
    // determinism as the config files themselves. Stays undefined until a rewrite passes policy.
    // `updatedInputHooks` records each contributor's approval key (25 M9 attribution).
    let updatedInput: Record<string, unknown> | undefined;
    const updatedInputHooks: string[] = [];

    for (const hook of hooks) {
      const key = hookApprovalKey(hook);
      try {
        const run = await gateAndRun(hook, key, approvals, payload);
        if (run.kind === "diagnostic") {
          diagnostics.push({ hook: key, reason: run.reason, detail: run.detail });
          continue;
        }

        const decision = run.decision;
        log("hooks", "hook decision", {
          run: payload.runId.slice(0, 8),
          hook: key,
          tool: payload.toolName,
          decision: decision.decision,
          ms: run.durationMs,
          ...(decision.reason ? { reason: redactHookText(decision.reason) } : {}),
        });
        if (decision.context) {
          // Bounded at parse; attributed here so the model-facing note can cite its source.
          contexts.push({ hook: key, context: decision.context });
        }
        if (decision.decision !== "allow") {
          // First blocking decision wins: later hooks never run (D-003). A blocking hook's
          // updatedInput is moot - the tool will not execute - so only contexts ride along.
          return {
            decision: decision.decision,
            hook: key,
            ...(decision.reason ? { reason: decision.reason } : {}),
            contexts,
            diagnostics,
          };
        }
        if (decision.updatedInput !== undefined) {
          // The narrow rewrite path (25 M6, D-003): only allowlisted leaf fields pass, a
          // rejection keeps the ORIGINAL input and surfaces as a diagnostic, and the value
          // still faces the tool's normal schema decode at the executor boundary.
          const evaluated = evaluateUpdatedInput(payload.toolName, decision.updatedInput);
          if (evaluated.ok) {
            updatedInput = { ...updatedInput, ...evaluated.fields };
            updatedInputHooks.push(key);
          } else {
            diagnostics.push({
              hook: key,
              reason: "updated_input_rejected",
              detail: evaluated.detail,
            });
            warn("hooks", "updatedInput rejected", { hook: key, detail: evaluated.detail });
          }
        }
      } catch (cause) {
        // Dispatch never rejects (D-007): an unexpected fault in one hook's gate/run is that
        // hook's diagnostic, and the remaining hooks still get their say.
        diagnostics.push({
          hook: key,
          reason: "command_failed",
          detail: redactHookText(cause instanceof Error ? cause.message : String(cause)),
        });
        warn("hooks", "hook dispatch fault", { hook: key });
      }
    }

    return {
      decision: "allow",
      contexts,
      ...(updatedInput && Object.keys(updatedInput).length > 0
        ? { updatedInput, updatedInputHooks }
        : {}),
      diagnostics,
    };
  };

  const dispatchStop = async (payload: StopPayload): Promise<StopOutcome> => {
    const hooks = discovery().hooks.filter((hook) => hook.event === "Stop" && hook.enabled);
    if (hooks.length === 0) {
      return { decision: "allow", contexts: [], diagnostics: [] };
    }
    const approvals = loadHookApprovals(approvalsPath);
    const diagnostics: StopDiagnostic[] = [];
    const contexts: StopContext[] = [];

    for (const hook of hooks) {
      const key = hookApprovalKey(hook);
      try {
        const run = await gateAndRun(hook, key, approvals, payload);
        if (run.kind === "diagnostic") {
          diagnostics.push({ hook: key, reason: run.reason, detail: run.detail });
          continue;
        }

        const decision = run.decision;
        log("hooks", "hook decision", {
          run: payload.runId.slice(0, 8),
          hook: key,
          event: "Stop",
          decision: decision.decision,
          ms: run.durationMs,
          ...(decision.reason ? { reason: redactHookText(decision.reason) } : {}),
        });
        if (decision.context) {
          // Bounded at parse; attributed so the continuation prompt (M8) can cite its source.
          contexts.push({ hook: key, context: decision.context });
        }
        if (decision.decision !== "allow") {
          // First blocking decision wins (D-003 tradition). Stop's only block is halt, so a
          // stray "deny" normalizes to halt rather than minting a third finalization verb; a
          // Stop decision's `updatedInput` is ignored wholesale - it rewrites nothing (D-004).
          return {
            decision: "halt",
            hook: key,
            ...(decision.reason ? { reason: decision.reason } : {}),
            contexts,
            diagnostics,
          };
        }
      } catch (cause) {
        // Dispatch never rejects (D-007): an unexpected fault in one hook's gate/run is that
        // hook's diagnostic, and the remaining hooks still get their say.
        diagnostics.push({
          hook: key,
          reason: "command_failed",
          detail: redactHookText(cause instanceof Error ? cause.message : String(cause)),
        });
        warn("hooks", "hook dispatch fault", { hook: key });
      }
    }

    return { decision: "allow", contexts, diagnostics };
  };

  // The doctor-facing picture (M9): trust is evaluated FRESH per snapshot (approvals re-read,
  // fingerprints recomputed) so /doctor reflects an approval or a script edit immediately, on
  // the same cached discovery every dispatch uses. `legacy` is the M10 HOOK.md migration scan -
  // report-only, per snapshot (a migration or a new stray file shows up without a restart).
  const statusSnapshot = (): HooksStatusSnapshot => {
    const report = discovery();
    const approvals = loadHookApprovals(approvalsPath);
    return {
      hooks: report.hooks.map((hook) => {
        const key = hookApprovalKey(hook);
        const fingerprint = computeHookTrustFingerprint(hook, trustBaseDir(hook));
        return {
          key,
          event: hook.event,
          source: hook.source,
          enabled: hook.enabled,
          trust: evaluateHookTrust(fingerprint, approvedHashFor(approvals, key)),
        };
      }),
      issues: report.issues,
      legacy: discoverLegacyHookFiles({
        workspaceRoot,
        ...(options.legacyUserHooksDir ? { legacyUserHooksDir: options.legacyUserHooksDir } : {}),
      }),
    };
  };

  return {
    dispatchPreToolUse,
    dispatchStop,
    statsSnapshot: () => stats.snapshot(),
    discoveryReport: () => discovery(),
    statusSnapshot,
  };
}
