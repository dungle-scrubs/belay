import { events, type ModelRef, type TrevorEventInput } from "@belay/session";

/**
 * The continuation-handoff orchestration (02, M2: direct flow), kept pure over injected effects so the
 * event sequence and ordering are unit-tested without a running host - `main.ts` wires the real
 * transport / session-mint / host-spawn / switch behind {@link DirectHandoffDeps}, the same shape the
 * `session-lifecycle` and `workspace-switch` modules use.
 *
 * Direct handoff sends the user-supplied prompt to a FRESH target session verbatim (no model
 * generation). The lifecycle rides the SOURCE log (`handoff.requested` -> `handoff.accepted`); the
 * TARGET log gets its provenance (`handoff.accepted`) plus the first `user.message` BEFORE the switch,
 * so the spawned target host replays a log that already carries the work and the browser lands on a
 * running turn. An empty prompt fails early (`handoff.failed`) and never switches - the source session
 * stays exactly as it was.
 *
 * Responsible for: executing a finalized handoff - target session mint, prompt injection, switch.
 * Not for: parsing /handoff args (handoff.ts) or drafting the prompt (handoff-generate.ts).
 */

/** The provider/model the target's first prompt runs on - the source's last-turn selection. */
export interface HandoffModel {
  readonly provider: string;
  readonly model?: ModelRef;
  readonly reasoning?: string;
}

/** The effects a direct handoff orchestrates; main.ts supplies the real transport/spawn/switch. */
export interface DirectHandoffDeps {
  readonly sourceSessionId: string;
  readonly cwd: string;
  readonly workspace: string;
  /** A fresh handoff id correlating the source lifecycle with the target provenance. */
  newHandoffId(): string;
  /** A fresh target session id. */
  newSessionId(): string;
  /** The provider/model to carry onto the target's first prompt (so it resumes the user's model). */
  targetModel(): HandoffModel;
  /** Publish a host-authored lifecycle event (handoff.*) to a session log. */
  publish(sessionId: string, event: TrevorEventInput): Promise<void>;
  /**
   * Publish a RUNNABLE prompt (the target's first user.message). It must be stamped with a producer
   * the target host will schedule a turn for - NOT the host's own producer id, which the turn loop
   * treats as a self-echo and ignores (the same control-producer path host-issued control prompts
   * use). Separate from `publish` precisely so the prompt actually runs.
   */
  publishPrompt(sessionId: string, event: TrevorEventInput): Promise<void>;
  /** Create the target session in the store before any event is written to it. */
  ensureSession(sessionId: string): Promise<void>;
  /** Spawn/attach a host for the target session so it can run the injected prompt. */
  spawnHost(target: {
    readonly cwd: string;
    readonly sessionId: string;
    readonly workspace: string;
  }): void;
  /** Publish the `session.switch` the browser follows, then retire this (source) host. */
  switchAndRetire(targetSessionId: string): Promise<void>;
}

export interface DirectHandoffResult {
  readonly ok: boolean;
  readonly text: string;
  readonly targetSessionId?: string;
}

/**
 * The shared FINALIZED-PROMPT execution path, reached once a final target prompt exists - directly
 * (`/handoff --direct <prompt>`) or after a generated draft is approved (`/handoff`). It ensures the
 * target session, writes its provenance + first runnable prompt BEFORE the switch, closes the source
 * lifecycle with `handoff.accepted`, spawns the target host, and switches the browser into it. The
 * `handoff.requested` event (which carries the mode/provenance) is the CALLER's responsibility, so
 * direct and generated stay distinguishable in the source log while sharing this execution exactly -
 * the seam that keeps the two modes from drifting. <!-- D-002 -->
 */
export async function executeFinalizedHandoff(
  args: { readonly handoffId: string; readonly prompt: string },
  deps: DirectHandoffDeps,
): Promise<DirectHandoffResult> {
  const { handoffId, prompt } = args;
  const targetSessionId = deps.newSessionId();
  await deps.ensureSession(targetSessionId);

  // Target log, BEFORE the switch: provenance, then the first prompt the target host will run.
  await deps.publish(
    targetSessionId,
    events.handoffAccepted({ handoffId, targetSessionId, prompt }),
  );
  const model = deps.targetModel();
  await deps.publishPrompt(
    targetSessionId,
    events.userMessage({
      text: prompt,
      provider: model.provider,
      ...(model.model ? { model: model.model } : {}),
      ...(model.reasoning ? { reasoning: model.reasoning } : {}),
    }),
  );

  // Source lifecycle close, then spawn the target host and switch the browser into it.
  await deps.publish(
    deps.sourceSessionId,
    events.handoffAccepted({ handoffId, targetSessionId, prompt }),
  );
  deps.spawnHost({ cwd: deps.cwd, sessionId: targetSessionId, workspace: deps.workspace });
  await deps.switchAndRetire(targetSessionId);

  return { ok: true, text: `✓ handed off to ${targetSessionId}`, targetSessionId };
}

/**
 * Run a direct (`/handoff --direct <prompt>`) handoff. Returns a command-result line for the source
 * session. On an empty prompt it emits `handoff.failed` and returns without ensuring, spawning, or
 * switching, so the source session is untouched. The non-empty path emits the direct `handoff.requested`
 * then defers to {@link executeFinalizedHandoff} - the same execution generated approval reuses.
 */
export async function runDirectHandoff(
  rawPrompt: string,
  deps: DirectHandoffDeps,
): Promise<DirectHandoffResult> {
  const handoffId = deps.newHandoffId();
  const prompt = rawPrompt.trim();
  if (!prompt) {
    await deps.publish(
      deps.sourceSessionId,
      events.handoffFailed({
        handoffId,
        code: "empty_prompt",
        detail: "Direct handoff needs a prompt.",
      }),
    );
    return { ok: false, text: "usage: /handoff --direct <prompt>" };
  }

  // Source lifecycle: this session requested a direct handoff.
  await deps.publish(
    deps.sourceSessionId,
    events.handoffRequested({
      handoffId,
      mode: "direct",
      sourceSessionId: deps.sourceSessionId,
      prompt,
    }),
  );

  return executeFinalizedHandoff({ handoffId, prompt }, deps);
}
