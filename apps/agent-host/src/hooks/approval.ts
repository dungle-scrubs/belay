import { storagePathByName } from "@belay/session/node-paths";
import { loadJsonConfig, writeJsonConfig } from "@host/boot/config";
import { asNonEmptyString, asRecord } from "@host/boot/decode";
import type { HookDefinition } from "./config";

/**
 * The hook approval store and THE execution gate (plan 25 M2, D-006). Approval is explicit
 * trust: a project/user hook NEVER executes before the user approves its current trust hash,
 * and any change to config or referenced scripts re-closes the gate until re-approval.
 * Approvals live in `<BELAY_STATE_HOME>/hooks-approvals.json` (machine-local runtime state,
 * routed through the storage inventory) keyed by {@link hookApprovalKey}, each record holding
 * the approved `sha256:` hash and when it was granted. State transitions are pure - callers
 * load, transform, save - so the store stays inspectable and unit-testable without disk. The
 * runtime enforces the gate by evaluating a hook's fresh fingerprint against
 * {@link approvedHashFor} (./trust's `evaluateHookTrust`); anything but `approved` reports
 * through diagnostics and never executes.
 *
 * Responsible for: approval persistence (approve/lookup) and the approval-key scheme.
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

/** The storage-inventory name of the approvals file owned by `@belay/session/node-paths`. */
const HOOK_APPROVALS_ENTRY = "hook-approvals";

/** The approvals file under the state root, resolved through the root-policy inventory. */
export function hookApprovalsPath(): string {
  return storagePathByName(HOOK_APPROVALS_ENTRY);
}

/**
 * The store key for one hook. A USER hook is `user:<id>` - it is the same hook wherever the
 * host runs. A PROJECT hook is `project:<abs workspace root>:<id>`: the workspace root scopes
 * the approval, so a hook approved in repo A never auto-executes in repo B just because repo B
 * ships byte-identical config (the fingerprint alone cannot tell the two apart). Provenance is
 * in the key too, so a project approval never trusts the same bytes arriving as a user hook.
 */
export function hookApprovalKey(
  hook: Pick<HookDefinition, "source" | "id">,
  workspaceRoot: string,
): string {
  return hook.source === "project" ? `project:${workspaceRoot}:${hook.id}` : `user:${hook.id}`;
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

/** The approved hash stored under `key`, or undefined when never approved. */
export function approvedHashFor(state: HookApprovalsState, key: string): string | undefined {
  return state.approvals[key]?.hash;
}
