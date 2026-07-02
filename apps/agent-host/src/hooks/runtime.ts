import { TREVOR_HOME, WORKSPACE_ROOT } from "@host/boot/paths";
import { debug, log, warn } from "@host/transport/log";
import { approvedHashFor, hookApprovalKey, hookApprovalsPath, loadHookApprovals } from "./approval";
import type { HookDecisionKind } from "./decision";
import {
  defaultHookDiscoveryRoots,
  discoverHooks,
  type HookDiscoveryReport,
  type HookDiscoveryRoots,
} from "./discovery";
import { evaluateUpdatedInput } from "./input-policy";
import { redactHookText } from "./redact";
import { type HookDiagnosticReason, hookExecutionOutcome, hookTrustOutcome } from "./results";
import { type HookRunnerOptions, runHook } from "./runner";
import { createHookStats, type HookStatsEntry } from "./stats";
import { computeHookTrustFingerprint, evaluateHookTrust } from "./trust";

/**
 * The hooks RUNTIME (plan 25 M5): the host-lifetime seam that composes discovery, trust
 * evaluation, the approval gate, execution, and per-hook stats into one dispatch surface, in
 * the mcp/lsp host-runtime tradition (construction touches nothing; discovery is lazy and
 * cached for the host's lifetime, approvals re-read per dispatch so a fresh grant takes effect
 * without a restart). `dispatchPreToolUse` runs every enabled, APPROVED PreToolUse hook in
 * config order (project root before user root, D-001); the first blocking decision (deny/halt)
 * short-circuits the rest (D-003), unapproved/changed/missing-script hooks contribute
 * diagnostics without ever executing (D-006), and every failure mode is a non-blocking
 * diagnostic (D-007) - dispatch itself NEVER rejects. Allow decisions can additionally carry
 * bounded, attributed context notes and an allowlist-scoped input rewrite (25 M6, D-003 -
 * ./input-policy owns the table). Everything logged here is redacted (D-009); transcript
 * events are M9's, so callers get the outcome as data.
 *
 * Responsible for: the PreToolUse payload/outcome contracts and the discovery -> trust ->
 * approval -> execution -> outcome dispatch pipeline.
 * Not for: the host singleton (./host-runtime), loop-side enforcement of an outcome
 * (@host/agent/loop), or per-module mechanics (./discovery, ./trust, ./approval, ./runner).
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
  readonly diagnostics: readonly PreToolUseDiagnostic[];
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
  /** Runner tunables passed through to every execution; injectable for tests. */
  readonly runnerOptions?: Omit<HookRunnerOptions, "cwd">;
}

export interface HooksRuntime {
  /** Runs the PreToolUse gate for one tool call. Resolves ALWAYS - never rejects (D-007). */
  readonly dispatchPreToolUse: (payload: PreToolUsePayload) => Promise<PreToolUseOutcome>;
  /** The per-hook run counters for Doctor (M9). */
  readonly statsSnapshot: () => readonly HookStatsEntry[];
  /** The cached discovery report (definitions + config issues) for Doctor (M9). */
  readonly discoveryReport: () => HookDiscoveryReport;
}

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
    let updatedInput: Record<string, unknown> | undefined;

    for (const hook of hooks) {
      const key = hookApprovalKey(hook);
      try {
        const baseDir = hook.source === "project" ? workspaceRoot : userConfigDir;
        const fingerprint = computeHookTrustFingerprint(hook, baseDir);
        const status = evaluateHookTrust(fingerprint, approvedHashFor(approvals, key));
        const trustDiagnostic = hookTrustOutcome(status);
        if (trustDiagnostic) {
          // The gate stays closed (D-006): report, never execute - and never block the tool.
          diagnostics.push({ hook: key, ...trustDiagnostic });
          debug("hooks", "hook skipped", { hook: key, reason: trustDiagnostic.reason });
          continue;
        }

        const execution = await runHook(hook, payload, {
          cwd: workspaceRoot,
          ...options.runnerOptions,
        });
        const outcome = hookExecutionOutcome(execution);
        stats.record(hook, execution, outcome);

        if (outcome.kind === "diagnostic") {
          diagnostics.push({ hook: key, reason: outcome.reason, detail: outcome.detail });
          warn("hooks", "hook diagnostic", {
            hook: key,
            reason: outcome.reason,
            detail: outcome.detail,
            ms: execution.durationMs,
          });
          continue;
        }

        const decision = outcome.decision;
        log("hooks", "hook decision", {
          run: payload.runId.slice(0, 8),
          hook: key,
          tool: payload.toolName,
          decision: decision.decision,
          ms: execution.durationMs,
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
      ...(updatedInput && Object.keys(updatedInput).length > 0 ? { updatedInput } : {}),
      diagnostics,
    };
  };

  return {
    dispatchPreToolUse,
    statsSnapshot: () => stats.snapshot(),
    discoveryReport: () => discovery(),
  };
}
