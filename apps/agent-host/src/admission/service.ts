import {
  type AdmissionEstimate,
  type AdmissionPriority,
  generationResourceKey,
  lifecycleResourceKey,
} from "./contract";
import {
  type AdmissionHandle,
  type AdmissionReporter,
  type AdmissionStatusListener,
  admit,
} from "./runtime";
import { ADMISSION_DEFAULT_CAPACITY, type AdmissionCaps, nodeAdmissionCaps } from "./store";

/**
 * The host-facing local-admission GATE (plan 11 M5/M6): the single seam the LM Studio provider acquires
 * generation + lifecycle admission through, so the provider stays a thin shim and all the owner/priority/
 * capacity/caps wiring lives here. Generation admission serializes active streams per concrete model
 * (`local-provider:...`); lifecycle admission serializes `lms load`/`unload` per endpoint
 * (`local-provider-lifecycle:...`) so two processes never run competing reloads against one runtime.
 *
 * The gate is built ONCE per host with the host's identity + the node-backed caps; it resolves the
 * per-turn context (priority, session/run/agent ids) through an injected resolver so a foreground turn
 * outranks a background subagent without the provider needing per-turn arguments. Only local providers
 * are given a gate, so cloud providers bypass admission entirely (D-005).
 */

/** The concrete local target a request is for (the generation key is per model, lifecycle per endpoint). */
export interface LocalAdmissionTarget {
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
}

/** The per-turn context the host resolves at acquire time: priority + best-effort attribution. */
export interface LocalAdmissionContext {
  readonly priority: AdmissionPriority;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly projectRoot?: string;
}

/** The default context when the host has not set one: a foreground user turn (the conservative, most
 *  common case - it never under-prioritizes real user work). */
export const DEFAULT_ADMISSION_CONTEXT: LocalAdmissionContext = { priority: "foreground" };

/** The gate the provider holds: acquire a generation lease (held through the stream) and run a lifecycle
 *  op under the endpoint lease. */
export interface LocalAdmissionGate {
  acquireGeneration(
    target: LocalAdmissionTarget,
    opts?: {
      readonly estimate?: AdmissionEstimate;
      readonly signal?: AbortSignal;
      readonly onStatus?: AdmissionStatusListener;
      /** The per-turn context (priority + attribution); overrides the gate's default resolver. */
      readonly context?: LocalAdmissionContext;
    },
  ): Promise<AdmissionHandle>;
  withLifecycle<T>(
    target: Pick<LocalAdmissionTarget, "provider" | "baseUrl" | "model">,
    fn: () => Promise<T>,
  ): Promise<T>;
}

/** Everything the gate needs from the host, all injectable so the gate is unit-tested without real
 *  processes, files, or env. */
export interface LocalAdmissionDeps {
  /** The host instance id stamped on every owner record. */
  readonly hostId: string;
  /** A fresh, unique owner id per acquire attempt. */
  readonly newOwnerId: () => string;
  /** The node-backed (or fake) store capabilities; defaults to the real ones. */
  readonly caps?: AdmissionCaps;
  /** Resolves the current turn's context (priority + ids); defaults to a foreground user turn. */
  readonly resolveContext?: () => LocalAdmissionContext;
  /** The configured active capacity for a resource key; defaults to {@link ADMISSION_DEFAULT_CAPACITY}. */
  readonly capacityFor?: (key: string) => number;
  /** Process pid stamped on owner records (default `process.pid`); injectable for tests. */
  readonly pid?: number;
  /** The fail-open log reporter. */
  readonly report?: AdmissionReporter;
}

/** Builds the host's local-admission gate. */
export function createLocalAdmissionGate(deps: LocalAdmissionDeps): LocalAdmissionGate {
  const caps = deps.caps ?? nodeAdmissionCaps();
  const resolveContext = deps.resolveContext ?? (() => DEFAULT_ADMISSION_CONTEXT);
  const capacityFor = deps.capacityFor ?? (() => ADMISSION_DEFAULT_CAPACITY);
  const pid = deps.pid ?? process.pid;

  const ownerFor = (target: LocalAdmissionTarget, ctx: LocalAdmissionContext) => ({
    ownerId: deps.newOwnerId(),
    hostId: deps.hostId,
    pid,
    provider: target.provider,
    model: target.model,
    ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
    ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
    ...(ctx.projectRoot !== undefined ? { projectRoot: ctx.projectRoot } : {}),
  });

  return {
    acquireGeneration(target, opts) {
      const key = generationResourceKey(target.provider, target.baseUrl, target.model);
      const ctx = opts?.context ?? resolveContext();
      return admit(
        {
          key,
          owner: ownerFor(target, ctx),
          priority: ctx.priority,
          estimate: opts?.estimate,
          capacity: capacityFor(key),
          signal: opts?.signal,
          onStatus: opts?.onStatus,
        },
        caps,
        deps.report,
      );
    },
    async withLifecycle(target, fn) {
      const key = lifecycleResourceKey(target.provider, target.baseUrl);
      const ctx = resolveContext();
      const handle = await admit(
        {
          key,
          owner: ownerFor({ ...target }, ctx),
          priority: ctx.priority,
          capacity: capacityFor(key),
        },
        caps,
        deps.report,
      );
      try {
        return await fn();
      } finally {
        await handle.release("success");
      }
    },
  };
}
