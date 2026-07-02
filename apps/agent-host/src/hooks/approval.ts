import { loadJsonConfig, writeJsonConfig } from "@host/boot/config";
import { asNonEmptyString, asRecord } from "@host/boot/decode";
import { storagePathByName } from "@trevor/session/node-paths";
import type { HookDefinition } from "./config";
import type { HookTrustStatus } from "./trust";

/**
 * The hook approval store and THE execution gate (plan 25 M2, D-006). Approval is explicit
 * trust: a project/user hook NEVER executes before the user approves its current trust hash,
 * and any change to config or referenced scripts re-closes the gate until re-approval.
 * Approvals live in `<TREVOR_STATE_HOME>/hooks-approvals.json` (machine-local runtime state,
 * routed through the storage inventory) keyed by `<source>:<id>`, each record holding the
 * approved `sha256:` hash and when it was granted. State transitions are pure - callers load,
 * transform, save - so the store stays inspectable and unit-testable without disk. Execution
 * itself lands in M3; until then {@link canExecuteHook} is the single predicate that layer
 * must consult, while unapproved hooks keep reporting through discovery diagnostics.
 *
 * Responsible for: approval persistence (approve/revoke/lookup) and the trust execution gate.
 * Not for: computing trust hashes or statuses - ./trust owns those.
 */

/** One granted approval: the exact fingerprint hash the user trusted, and when. */
export interface HookApprovalRecord {
  readonly hash: string;
  readonly approvedAt?: string;
}

export interface HookApprovalsState {
  readonly approvals: Readonly<Record<string, HookApprovalRecord>>;
}

export const EMPTY_HOOK_APPROVALS: HookApprovalsState = { approvals: {} };

/** The storage-inventory name of the approvals file owned by `@trevor/session/node-paths`. */
const HOOK_APPROVALS_ENTRY = "hook-approvals";

/** The approvals file under the state root, resolved through the root-policy inventory. */
export function hookApprovalsPath(): string {
  return storagePathByName(HOOK_APPROVALS_ENTRY);
}

/** The store key for one hook: `<source>:<id>` - provenance-scoped, so a project approval
 *  never trusts the same bytes arriving as a user hook. */
export function hookApprovalKey(hook: Pick<HookDefinition, "source" | "id">): string {
  return `${hook.source}:${hook.id}`;
}

/** Tolerantly decodes a raw approvals file; entries without a usable hash are dropped. Pure. */
export function normalizeHookApprovals(raw: unknown): HookApprovalsState {
  const entries = asRecord(asRecord(raw)?.approvals);
  if (!entries) {
    return EMPTY_HOOK_APPROVALS;
  }
  const approvals: Record<string, HookApprovalRecord> = {};
  for (const [key, rawRecord] of Object.entries(entries)) {
    const record = asRecord(rawRecord);
    const hash = asNonEmptyString(record?.hash);
    if (!hash) {
      continue;
    }
    const approvedAt = asNonEmptyString(record?.approvedAt);
    approvals[key] = { hash, ...(approvedAt ? { approvedAt } : {}) };
  }
  return { approvals };
}

/** Loads the approvals state; a missing or malformed file means nothing is approved. */
export function loadHookApprovals(
  path: string = hookApprovalsPath(),
  read?: (path: string) => string,
): HookApprovalsState {
  return loadJsonConfig(path, normalizeHookApprovals, EMPTY_HOOK_APPROVALS, read);
}

/** Writes the approvals state as pretty JSON under the state root. */
export function saveHookApprovals(
  state: HookApprovalsState,
  path: string = hookApprovalsPath(),
  write?: (path: string, content: string) => void,
): void {
  writeJsonConfig(path, state, write);
}

/** Grants approval for exactly `hash` under `key`, replacing any prior approval. Pure. */
export function approveHook(
  state: HookApprovalsState,
  key: string,
  hash: string,
  approvedAt: string = new Date().toISOString(),
): HookApprovalsState {
  return { approvals: { ...state.approvals, [key]: { hash, approvedAt } } };
}

/** Withdraws any approval under `key`. Pure. */
export function revokeHookApproval(state: HookApprovalsState, key: string): HookApprovalsState {
  const { [key]: _removed, ...rest } = state.approvals;
  return { approvals: rest };
}

/** The approved hash stored under `key`, or undefined when never approved (or revoked). */
export function approvedHashFor(state: HookApprovalsState, key: string): string | undefined {
  return state.approvals[key]?.hash;
}

/**
 * THE trust gate (D-006): only a hook whose current fingerprint the user explicitly approved
 * may execute. Unapproved, changed, and missing-script hooks are diagnostics, never executions.
 * The M3 execution harness must consult this predicate before running anything.
 */
export function canExecuteHook(status: HookTrustStatus): boolean {
  return status === "approved";
}
