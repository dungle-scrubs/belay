import type { CompactionController } from "@host/agent/compaction-controller";
import type { TurnScheduler } from "@host/agent/turn-scheduler";
import { WORKSPACE_ROOT } from "@host/boot/paths";
import { contextRegistry } from "@host/project-context/registry";
import type { ChatMessage } from "@host/providers/index";
import type { SessionSwitchApi } from "@host/session/session-switch";
import { log, warn } from "@host/transport/log";
import { msg } from "@host/transport/messages";
import type { EmitEvent } from "@host/transport/services";
import { events, freshSessionId, type SessionTransport } from "@trevor/session";
import { Cause, Effect, Exit, Fiber } from "effect";
import { parseHandoff } from "./handoff";
import {
  type DirectHandoffDeps,
  executeFinalizedHandoff,
  type HandoffModel,
  runDirectHandoff,
} from "./handoff-flow";
import { generateHandoffPrompt, hasGenerableContext } from "./handoff-generate";

/**
 * The /handoff orchestration (02 direct mode, 02.10 generated mode), extracted from main.ts (plan
 * 22.2 M2): main.ts constructs {@link makeHandoffOrchestrator} once over its live switch mechanics
 * (spawn/retire/scheduler), control-model resolution, and prompt projection, and keeps dispatching
 * from its command lane and handleEvent arms under the same local names. The pending-draft map and
 * the in-flight draft fiber live here so approve/reject and the handleEvent lifecycle arms
 * (noteGenerated/noteSettled) share one source of truth.
 *
 * Responsible for: the /handoff command flow - direct execution, draft generation, approval,
 * rejection - and the pending-draft state the handoff.* lifecycle arms track.
 * Not for: parsing /handoff args (handoff.ts), executing a finalized handoff (handoff-flow.ts),
 * drafting the prompt (handoff-generate.ts), or the switch mechanics themselves (main.ts wires
 * those in as deps).
 */

/** The live main.ts state and switch mechanics the orchestration runs through. */
export interface HandoffOrchestratorDeps {
  /** The source session's id (main.ts's SESSION_ID, computed from env). */
  readonly sessionId: string;
  /** The host's shared producer id, stamped on lifecycle events. */
  readonly producerId: string;
  /** The control producer id the injected target prompt rides (never the bare host id). */
  readonly controlProducerId: string;
  /** The durable-log transport: target-session creation + cross-session publishes. */
  readonly transport: Pick<SessionTransport, "publishEvent" | "ensureSession">;
  /** Publish one host-authored event to THIS session's log (main.ts's emit). */
  readonly emit: EmitEvent;
  /** The prompt projection right now (main.ts's mutable `history`). */
  history(): readonly ChatMessage[];
  /** The draft's provider - the source's last-turn provider, else the default. */
  readonly compactionController: Pick<CompactionController, "providerOrDefault">;
  /** The provider + model the target's first prompt resolves to (main.ts's controlModel). */
  controlModel(): HandoffModel;
  /** The shared workspace-switch precondition: emits the bail result and returns true when blocked. */
  readonly blockedFromWorkspaceSwitch: SessionSwitchApi["blockedFromWorkspaceSwitch"];
  /** Spawn the replacement host for the target session (main.ts's spawnReplacementHost). */
  readonly spawnReplacementHost: SessionSwitchApi["spawnReplacementHost"];
  /** Drop the deferred prompt queue before retiring (the switch mechanic's scheduler half). */
  readonly scheduler: Pick<TurnScheduler, "clearPending">;
  /** Retire this host after the session.switch (main.ts's retireAfterSessionSwitch). */
  readonly retireAfterSessionSwitch: SessionSwitchApi["retireAfterSessionSwitch"];
}

/** Builds the /handoff orchestration over the host's live switch mechanics; main.ts wires it once. */
export function makeHandoffOrchestrator(deps: HandoffOrchestratorDeps) {
  const {
    sessionId: SESSION_ID,
    producerId: PRODUCER_ID,
    controlProducerId: CONTROL_PRODUCER_ID,
    transport,
    emit,
    history,
    compactionController,
    controlModel,
    blockedFromWorkspaceSwitch,
    spawnReplacementHost,
    scheduler,
    retireAfterSessionSwitch,
  } = deps;

  /**
   * Drafts pending generated handoffs by `handoffId`: the generated target prompt awaiting the user's
   * approve/edit/reject. Set when `handoff.generated` lands (live OR replayed, so a fresh leader can still
   * honor an approval) and cleared on the terminal `handoff.accepted` / `.rejected` / `.failed`. An
   * approval for an id not in this map is stale (host restarted past the draft) and is refused. <!-- D-003 -->
   */
  const pendingHandoffs = new Map<string, { readonly prompt: string }>();
  /** The in-flight handoff-draft generation fiber (one at a time), so a reject/cancel can interrupt it
   *  instead of letting an abandoned draft keep streaming into a `handoff.generated` nobody awaits. */
  let handoffDraftFiber: Fiber.RuntimeFiber<string, unknown> | null = null;
  /** A hung provider must not hang the draft forever: the generation fails (and the surface clears via
   *  handoff.failed) after this, so the handoff is never permanently stuck on a live host. */
  const HANDOFF_GENERATION_TIMEOUT = "90 seconds";

  /**
   * The real transport/mint/spawn/switch effects a handoff orchestrates, shared by direct mode and
   * generated approval so neither rebuilds target creation or the switch. Reuses the same
   * `spawnReplacementHost` + `session.switch` + retire mechanic as `/clear` and `/cd`. The injected
   * prompt rides the control producer (not PRODUCER_ID) so the target host schedules a turn for it
   * instead of ignoring it as a self-echo - the bug that left a handed-off session "Working" forever.
   */
  function handoffDeps(): DirectHandoffDeps {
    return {
      sourceSessionId: SESSION_ID,
      cwd: process.cwd(),
      workspace: WORKSPACE_ROOT,
      newHandoffId: () => crypto.randomUUID(),
      newSessionId: () => freshSessionId(),
      targetModel: controlModel,
      publish: (sessionId, event) =>
        transport.publishEvent(sessionId, { ...event, producerId: PRODUCER_ID }),
      publishPrompt: (sessionId, event) =>
        transport.publishEvent(sessionId, { ...event, producerId: CONTROL_PRODUCER_ID }),
      ensureSession: async (sessionId) => {
        await transport.ensureSession(sessionId);
      },
      spawnHost: (target) => {
        spawnReplacementHost(target);
      },
      switchAndRetire: async (targetSessionId) => {
        await emit(events.sessionSwitch({ sessionId: targetSessionId, reason: "handoff" }));
        scheduler.clearPending();
        contextRegistry.reset();
        retireAfterSessionSwitch();
      },
    };
  }

  /**
   * `/handoff` (02): continue this session's work in a FRESH target session. Direct mode (`--direct
   * <prompt>`) injects the prompt verbatim and switches immediately; generated mode (`/handoff` or
   * `/handoff <request>`) drafts a target prompt with the provider and waits for the user to approve,
   * edit, or reject it (02.10) before any target launches. Both are gated by the workspace-switch
   * blocker so a handoff never abandons a running source turn (the exact failure the turn reconcile
   * guards against) - direct gates before switching, generated gates before drafting.
   */
  async function runHandoff(args: string): Promise<void> {
    const { mode, prompt } = parseHandoff(args);
    if (await blockedFromWorkspaceSwitch("/handoff", "hand off")) {
      return;
    }
    if (mode === "generate") {
      await runGeneratedHandoff(prompt);
      return;
    }

    try {
      const result = await runDirectHandoff(prompt, handoffDeps());
      await emit(events.commandResult({ command: "/handoff", text: result.text, ok: result.ok }));
      if (result.ok) {
        log("host", "handoff: switched session", { from: SESSION_ID, to: result.targetSessionId });
      }
    } catch (error) {
      warn("host", "handoff failed", { error: msg(error) });
      await emit(
        events.commandResult({
          command: "/handoff",
          text: `Failed to hand off: ${msg(error)}`,
          ok: false,
        }),
      );
    }
  }

  /**
   * Generated handoff (02.10): emit the source lifecycle (`handoff.requested` generate -> `generating`),
   * draft the target prompt with the source's last-turn provider (the same provider compaction folds
   * with), then emit `handoff.generated` for the browser to surface for approval. No command result is
   * emitted here - the draft rides the approval surface, not a transcript line, so the source never shows
   * a misleading failure beside a pending draft. Failure (no context, no provider, provider error, empty
   * draft) emits a stable `handoff.failed` + a command result and leaves the source session active.
   */
  async function runGeneratedHandoff(request: string): Promise<void> {
    const handoffId = crypto.randomUUID();
    const fail = async (code: string, detail: string, resultText: string) => {
      await emit(events.handoffFailed({ handoffId, code, detail }));
      await emit(events.commandResult({ command: "/handoff", text: resultText, ok: false }));
    };

    if (!hasGenerableContext(history())) {
      await fail(
        "empty_context",
        "No conversation to summarize into a handoff.",
        "Nothing to hand off yet — start the work first, then /handoff.",
      );
      return;
    }
    const provider = compactionController.providerOrDefault();
    if (!provider) {
      await fail(
        "no_provider",
        "No provider available to generate.",
        "No provider available to generate a handoff.",
      );
      return;
    }

    await emit(
      events.handoffRequested({
        handoffId,
        mode: "generate",
        sourceSessionId: SESSION_ID,
        ...(request.trim() ? { prompt: request.trim() } : {}),
      }),
    );
    await emit(events.handoffGenerating({ handoffId }));

    // Run the draft as a tracked fiber (not runPromiseExit) so a reject during drafting can interrupt it,
    // bounded by a timeout so a hung provider can't hang it forever.
    const fiber = Effect.runFork(
      generateHandoffPrompt(provider, {
        history: history().slice(),
        cwd: process.cwd(),
        workspace: WORKSPACE_ROOT,
        ...(request.trim() ? { request: request.trim() } : {}),
      }).pipe(Effect.timeout(HANDOFF_GENERATION_TIMEOUT)),
    );
    handoffDraftFiber = fiber;
    const exit = await Effect.runPromise(Fiber.await(fiber));
    handoffDraftFiber = null;

    if (Exit.isFailure(exit)) {
      // Interruption = the user cancelled mid-draft (rejectHandoff already acknowledged + cleared the
      // surface), so emit nothing further. Any other failure (provider error / timeout) fails the handoff.
      if (Cause.isInterruptedOnly(exit.cause)) {
        return;
      }
      warn("host", "handoff generation failed", { cause: Cause.pretty(exit.cause) });
      await fail(
        "generation_failed",
        "The provider failed or timed out while generating the handoff.",
        "Could not generate a handoff prompt — try again, or /handoff --direct <prompt>.",
      );
      return;
    }
    const draft = exit.value.trim();
    if (!draft) {
      await fail(
        "empty_generation",
        "The model produced no handoff prompt.",
        "The model produced an empty handoff prompt — try again, or /handoff --direct <prompt>.",
      );
      return;
    }

    pendingHandoffs.set(handoffId, { prompt: draft });
    await emit(events.handoffGenerated({ handoffId, prompt: draft }));
    log("host", "handoff: generated draft", { handoffId: handoffId.slice(0, 8) });
  }

  /**
   * The user approved a generated handoff (from the browser's approval surface). Runs the shared
   * finalized-execution path with the approved prompt - the edited text when the user edited it in the
   * prompt editor, else the generated draft. A stale id (no pending draft, e.g. the host restarted past
   * it) is a no-op with a clear command result; the source session stays active. <!-- D-003 -->
   */
  async function approveHandoff(
    handoffId: string,
    editedPrompt: string | undefined,
  ): Promise<void> {
    const pending = pendingHandoffs.get(handoffId);
    const prompt = (editedPrompt ?? "").trim() || pending?.prompt?.trim() || "";
    if (!prompt) {
      await emit(
        events.handoffFailed({
          handoffId,
          code: "stale_approval",
          detail: "No pending handoff draft.",
        }),
      );
      await emit(
        events.commandResult({
          command: "/handoff",
          text: "This handoff is no longer pending — run /handoff again.",
          ok: false,
        }),
      );
      pendingHandoffs.delete(handoffId);
      return;
    }
    try {
      const result = await executeFinalizedHandoff({ handoffId, prompt }, handoffDeps());
      await emit(events.commandResult({ command: "/handoff", text: result.text, ok: result.ok }));
      log("host", "handoff: approved + switched", { from: SESSION_ID, to: result.targetSessionId });
    } catch (error) {
      warn("host", "handoff approve failed", { error: msg(error) });
      await emit(events.handoffFailed({ handoffId, code: "execute_failed", detail: msg(error) }));
      await emit(
        events.commandResult({
          command: "/handoff",
          text: `Failed to hand off: ${msg(error)}`,
          ok: false,
        }),
      );
    } finally {
      pendingHandoffs.delete(handoffId);
    }
  }

  /** The user rejected/cancelled a handoff: interrupt any in-flight draft, drop the pending draft, and
   *  acknowledge; the source session stays active. Works while drafting (interrupt) or after (no-op). */
  async function rejectHandoff(handoffId: string): Promise<void> {
    pendingHandoffs.delete(handoffId);
    if (handoffDraftFiber) {
      const fiber = handoffDraftFiber;
      handoffDraftFiber = null;
      Effect.runFork(Fiber.interrupt(fiber));
    }
    await emit(
      events.commandResult({
        command: "/handoff",
        text: "Handoff cancelled — staying in this session.",
        ok: true,
      }),
    );
  }

  /** handleEvent's `handoff.generated` arm: track the draft (live OR replay) so an approval can run it. */
  function noteGenerated(handoffId: string, prompt: string): void {
    pendingHandoffs.set(handoffId, { prompt });
  }

  /** handleEvent's terminal-lifecycle arms (`handoff.accepted`/`.failed`/`.rejected`): drop the draft. */
  function noteSettled(handoffId: string): void {
    pendingHandoffs.delete(handoffId);
  }

  return { runHandoff, approveHandoff, rejectHandoff, noteGenerated, noteSettled, handoffDeps };
}
