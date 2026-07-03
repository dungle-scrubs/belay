import { DEFAULT_PROVIDER } from "@host/providers/index";
import {
  buildControlTurns,
  controlPromptModel,
  controlPromptProvider,
} from "@host/session/control-model";
import { MAX_RESTART_RESUMES, resumeAfterStop } from "@host/session/session-lifecycle";
import { copyLastCopyable, routeClip } from "@host/tools/clip";
import { getClipboardWriter } from "@host/tools/clipboard";
import { log, warn } from "@host/transport/log";
import { msg } from "@host/transport/messages";
import type { EmitEvent } from "@host/transport/services";
import {
  type ArtifactRef,
  events,
  type ModelRef,
  type PublishInput,
  type SessionTransport,
} from "@trevor/session";
import type { CompactionCommandsApi } from "./compaction-commands";
import type { CompactionController } from "./compaction-controller";
import type { ConversationLog } from "./conversation-log";
import {
  CONTINUATION_PREFIX,
  lastUserPrompt,
  RESTART_RESUME_REASON,
  resumeProjection,
} from "./resume-projection";
import type { TurnMachine } from "./turn-machine";

/**
 * The host-issued control prompts + the continuation lane, extracted from main.ts (plan 22.3):
 * main.ts constructs {@link makeControlPrompts} once over its live projection + transport and
 * keeps dispatching from its command lane, handleEvent's completion arm, and the LoopStore runner
 * under the same local names. The one owner of the control/clip prompt SHAPES (producer tagging +
 * provider/model resolution), so continuation, retry, /clip, and the loop runner can't rebuild
 * them subtly differently.
 *
 * Responsible for: the control/clip user.message shapes, publishing control prompts, the
 * continue/retry/compress-then-continue flows, the /clip lane, and the bounded auto-resume
 * decision after a pause/interrupt.
 * Not for: WHEN a turn runs (agent/turn-scheduler.ts), the resume projection/decision rules
 * (agent/resume-projection.ts + session/session-lifecycle.ts), or the manual /compact fold itself
 * (main.ts wires it in as the forceCompact dep).
 */

/** The live main.ts state the control-prompt lane reads - projection accessors + turn seams. */
export interface ControlPromptsDeps {
  /** The current session's id (main.ts's SESSION_ID, computed from env). */
  readonly sessionId: string;
  /** The host's bare producer id; used to recognize its derived control lanes. */
  readonly producerId: string;
  /** The control producer id host-issued prompts ride (never the bare host id). */
  readonly controlProducerId: string;
  /** The clip control producer id, so `startTurn` narrows a `/clip` turn's tool surface. */
  readonly clipProducerId: string;
  /** The durable-log transport: control prompts are published as answerable user.messages. */
  readonly transport: Pick<SessionTransport, "publishEvent">;
  /** Publish one host-authored event to the durable log (main.ts's emit). */
  readonly emit: EmitEvent;
  /** The live conversation log owner; control prompts read prompt history and durable events. */
  readonly conversationLog: Pick<ConversationLog, "history" | "events">;
  /** The compaction controller: the last turn's provider anchors the control-prompt resolution. */
  readonly compactionController: Pick<CompactionController, "providerOrDefault">;
  /** The turn machine: the last termination reason labels an auto-resume's continuation. */
  readonly turnMachine: Pick<TurnMachine, "lastTermination">;
  /** Runs the manual /compact fold now (main.ts's forceCompact, via agent/compaction-commands). */
  forceCompact: CompactionCommandsApi["forceCompact"];
}

/** Builds the control-prompt + continuation lane over the host's live state; main.ts wires it once. */
export function makeControlPrompts(deps: ControlPromptsDeps) {
  const {
    sessionId: SESSION_ID,
    producerId: PRODUCER_ID,
    controlProducerId: CONTROL_PRODUCER_ID,
    clipProducerId: CLIP_PRODUCER_ID,
    transport,
    emit,
    conversationLog,
    compactionController,
    turnMachine,
    forceCompact,
  } = deps;

  const autoContinuedRuns = new Set<string>();

  function controlProvider(): string {
    return compactionController.providerOrDefault()?.id ?? DEFAULT_PROVIDER;
  }

  /**
   * The provider + model a host-issued control prompt (auto-continue after a step-cap pause, retry,
   * compact-then-continue, handoff) resolves to, resolved in three tiers newest-first so a resumed turn
   * keeps the model it was actually running on:
   *   1. the most recent turn's explicit catalog ModelRef (round-trips its source/model), else
   *   2. the most recent REAL user turn's legacy provider string - skipping the host's own control
   *      prompts so the scan never re-inherits the compaction provider (the 02.13 fix), else
   *   3. the compaction/default provider - only a session with no real user turn yet.
   * Without tier 2 a legacy provider-string-only turn (a source id that does not round-trip through
   * `pickProvider`) silently downgraded to the host's LOCAL default model. The one resolver every
   * continuation/retry/handoff path shares.
   */
  function controlModel(): { readonly provider: string; readonly model: ModelRef | undefined } {
    const turns = buildControlTurns(conversationLog.events(), PRODUCER_ID);
    return {
      provider: controlPromptProvider(turns) ?? controlProvider(),
      model: controlPromptModel(turns),
    };
  }

  /**
   * The producer-tagged `user.message` for a host-issued control prompt: the control producer id (the
   * turn-scheduler self-echo contract that keeps a handed-off/continued session from ignoring it), the
   * resolved provider + last-turn model, and the event shape. The ONE owner of the control-prompt shape,
   * so continuation, retry, and handoff can't rebuild it three subtly-different ways. `provider`/`model`
   * default to the live resolution; a retry passes the original prompt's own values.
   */
  function controlPromptEvent(over: {
    readonly text: string;
    readonly provider?: string;
    readonly model?: ModelRef;
    readonly reasoning?: string;
    readonly artifacts?: readonly ArtifactRef[];
  }): PublishInput {
    const resolved = controlModel();
    return {
      ...events.userMessage({
        text: over.text,
        provider: over.provider ?? resolved.provider,
        model: over.model ?? resolved.model,
        reasoning: over.reasoning,
        artifacts: over.artifacts,
      }),
      producerId: CONTROL_PRODUCER_ID,
    };
  }

  async function publishControlPrompt(text: string, provider = controlProvider()): Promise<void> {
    await transport.publishEvent(SESSION_ID, controlPromptEvent({ text, provider }));
  }

  /** The prefix every continuation prompt shares; used to recognise a turn that is itself a continuation
   *  (so a step-budget pause is not auto-stacked). */
  async function continueAfterStop(reason: string): Promise<void> {
    await publishControlPrompt(
      `${CONTINUATION_PREFIX} Reason: ${reason}. Do not repeat completed work; proceed from the current transcript and finish the user's request.`,
    );
  }

  async function retryLastPrompt(): Promise<{ readonly ok: boolean; readonly text: string }> {
    const last = lastUserPrompt(conversationLog.events());
    if (!last) {
      return { ok: false, text: "No prior user prompt to retry." };
    }
    await transport.publishEvent(
      SESSION_ID,
      controlPromptEvent({
        text: last.text,
        provider: last.provider,
        model: last.model,
        reasoning: last.reasoning,
        artifacts: last.artifacts,
      }),
    );
    return { ok: true, text: "Retrying the last user prompt." };
  }

  /**
   * The producer-tagged `user.message` that drives a restricted `/clip <request>` turn (plan 06):
   * the clip control producer (so `startTurn` narrows the surface to clipboard_write), the resolved
   * provider + last-turn model, and the framed clip prompt as the turn's user text.
   */
  function clipPromptEvent(text: string): PublishInput {
    const resolved = controlModel();
    return {
      ...events.userMessage({ text, provider: resolved.provider, model: resolved.model }),
      producerId: CLIP_PRODUCER_ID,
    };
  }

  /**
   * The `/clip` command lane (plan 06). Bare `/clip` copies the last copyable transcript item through
   * the host clipboard abstraction and answers with a visible command.result - NO model turn. `/clip
   * <request>` publishes a clip-producer prompt that the turn machine runs as a restricted
   * clipboard-only turn. Only the live leader reaches here.
   */
  async function runClip(args: string): Promise<void> {
    const route = routeClip(args);
    if (route.kind === "copy") {
      const result = await copyLastCopyable(conversationLog.history(), getClipboardWriter());
      await emit(events.commandResult({ command: "/clip", text: result.text, ok: result.ok }));
      return;
    }
    await transport.publishEvent(SESSION_ID, clipPromptEvent(route.prompt));
  }

  async function compressThenContinue(): Promise<{ readonly ok: boolean; readonly text: string }> {
    const compacted = await forceCompact();
    if (
      compacted.startsWith("A turn is in progress") ||
      compacted.startsWith("A compaction is already running") ||
      compacted.startsWith("No provider available") ||
      compacted.startsWith("Compaction failed")
    ) {
      return { ok: false, text: compacted };
    }
    await continueAfterStop(`context was compacted first: ${compacted}`);
    return { ok: true, text: `${compacted}\nContinuing after compaction.` };
  }

  /**
   * Auto-resume the trailing turn when the log shows it stopped without finishing the user's request: a
   * host-restart interrupt (this host reaped it, or the browser recovered the orphan while no host was up)
   * is re-issued from the transcript, bounded to {@link MAX_RESTART_RESUMES} consecutive resumes before
   * falling back to a manual Resume so a crash-looping host cannot spin; a step-budget pause keeps the
   * existing auto-continue. Idempotent per run via `autoContinuedRuns`; callers gate it on live + leader,
   * so replay and standbys never fire. The decision is read from the durable log (not in-memory counters),
   * so the crash-loop bound survives the very restarts it guards.
   */
  function maybeAutoResume(): void {
    const { turn, inputs } = resumeProjection(conversationLog.events());
    if (!turn || !inputs || turn.continued || autoContinuedRuns.has(turn.runId)) {
      return;
    }
    const decision = resumeAfterStop(inputs);
    if (decision.kind === "none") {
      return;
    }
    autoContinuedRuns.add(turn.runId);
    if (decision.kind === "manual") {
      warn("host", "auto-resume exhausted; awaiting manual Resume", {
        run: turn.runId.slice(0, 8),
        after: MAX_RESTART_RESUMES,
      });
      return;
    }
    const reason =
      decision.cause === "restart"
        ? RESTART_RESUME_REASON
        : (turn.stopSummary ?? turnMachine.lastTermination ?? "turn paused");
    // Surface the resolved provider/model so a resume DOWNGRADE (a real turn provider that fell through
    // to the local default) is visible in host logs / debug, not silent. <!-- 02.13 -->
    const resolved = controlModel();
    log("host", "auto-resuming turn", {
      run: turn.runId.slice(0, 8),
      cause: decision.cause,
      ...(decision.cause === "restart" ? { attempt: decision.attempt } : {}),
      provider: resolved.provider,
      model: resolved.model ? `${resolved.model.sourceId}/${resolved.model.modelId}` : undefined,
    });
    continueAfterStop(reason).catch((error) =>
      warn("host", "auto-resume failed", { run: turn.runId.slice(0, 8), error: msg(error) }),
    );
  }

  return {
    controlModel,
    publishControlPrompt,
    continueAfterStop,
    retryLastPrompt,
    runClip,
    compressThenContinue,
    maybeAutoResume,
  };
}
