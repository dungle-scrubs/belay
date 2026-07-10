/**
 * E4/A14 read-only ExternalStore adapter spike (plan 58.6.3 M2) - THROWAWAY Storybook scaffold.
 *
 * Purpose: prove the single credible bridge to assistant-ui primitives that keeps Trevor's durable
 * log the sole source of truth - a READ-ONLY `useExternalStoreRuntime` fed by Trevor's existing
 * `toTranscript` projection (the same rows `SessionReadModel.transcript` at projection.ts:61 exposes),
 * with NO intents wired (onNew is a no-op). It converts one captured session's `Message[]` into
 * assistant-ui `ThreadMessageLike[]` and mounts it under `AssistantRuntimeProvider` + `ThreadPrimitive`.
 *
 * This is a research scaffold, not product code. It is deliberately kept OUT of `apps/web/src` so it
 * never ships. To run it live: copy this file + the `.stories.tsx` sibling into `apps/web/src/session/`
 * and open Storybook. It typechecks against the installed `@assistant-ui/react@0.14.23`.
 *
 * WHAT THE SPIKE MEASURES / SURFACES (recorded in findings.md):
 *  - render cost vs Trevor's bespoke rows (the converter runs per store change; see the memoization note)
 *  - the thread-id-sync footgun (projection.ts:90 already guards it Trevor-side; an adapter re-introduces it)
 *  - useShallow re-render behavior (converter returns fresh objects -> defeats structural sharing)
 *  - Trevor row kinds with NO assistant-ui part type (feeds the M3 mapping study)
 */

import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  type ThreadMessageLike,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { events, type SessionEvent } from "@trevor/session";
import { storedEvent } from "@trevor/test-kit";
import { useMemo } from "react";
// In-app these resolve via the "@/..." alias; from apps/web/src/session the relative path is "../transcript".
import type { Message } from "../../../../apps/web/src/transcript";
import { toTranscript } from "../../../../apps/web/src/transcript";

/**
 * The read-only converter: one Trevor transcript row -> one assistant-ui `ThreadMessageLike`.
 *
 * assistant-ui's message model has exactly three roles (user | assistant | system) and a closed set
 * of part types (text, reasoning, source, image, file, tool-call, generative-ui, plus escape-hatch
 * `data-${string}` custom parts). Trevor has ~18 row kinds (transcript.ts:378). The mapping below is
 * the M3 study made executable:
 *
 *  - user      -> role:"user"  + text part            (lossless core; pastes/artifacts -> attachments/data)
 *  - assistant -> role:"assistant" + reasoning + text  (lossless core; usage/stop/stepLimit -> metadata.custom)
 *  - tool      -> role:"assistant" + one tool-call part (near-lossless; aborted/startedAt -> timing/custom)
 *  - EVERY other kind (recovered, continued, reconnecting, guardrail, compacting, delegation,
 *    inlineAgent, shell, question, hookDecision, modelSwitch, limit, lucid, result) has NO native
 *    part type. To render at all it must become a `data-trevor-<kind>` custom part, which standard
 *    assistant-ui primitives do NOT display without a bespoke registered renderer. Recorded as LOSSY:
 *    persistable as opaque bytes, invisible to the stock primitives.
 *
 * `idx` is the array position; assistant-ui derives a fallback id from it when `id` is absent. We ALWAYS
 * pass Trevor's stable row id so identity survives a re-projection (see the thread-id-sync note).
 */
export function transcriptRowToThreadMessage(message: Message, _idx: number): ThreadMessageLike {
  switch (message.kind) {
    case "user":
      return {
        role: "user",
        id: message.id,
        content: [{ type: "text", text: message.text }],
      };
    case "assistant":
      return {
        role: "assistant",
        id: message.id,
        content: [
          ...(message.thinking ? [{ type: "reasoning" as const, text: message.thinking }] : []),
          ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
        ],
        // Rich turn metadata has no first-class home in ThreadMessageLike; it survives only as custom.
        metadata: {
          custom: {
            model: message.model,
            provider: message.provider,
            usage: message.usage,
            stop: message.stop,
            stepLimit: message.stepLimit,
            cancelled: message.cancelled,
            interrupted: message.interrupted,
          },
        },
      };
    case "tool":
      return {
        role: "assistant",
        id: message.id,
        content: [
          {
            type: "tool-call",
            toolCallId: message.id,
            toolName: message.name,
            argsText: message.args,
            result: message.result,
            isError: message.aborted,
          },
        ],
      };
    // Every remaining Trevor kind has NO assistant-ui part type. It goes into a custom data part so it
    // is not silently dropped - but a stock ThreadPrimitive shows nothing for it (M3: "lossy view").
    default:
      return {
        role: "assistant",
        id: message.id,
        content: [
          {
            type: `data-trevor-${message.kind}`,
            data: message as unknown,
          },
        ],
      };
  }
}

/** Build ONE realistic captured session log through the SAME event builders + `storedEvent` the
 *  transcript tests use, then fold it with the real `toTranscript`. This is the "one captured session"
 *  the spike renders - a user prompt, a reasoning+text assistant turn, a read tool, and a status row
 *  (modelSwitch) that exercises the no-native-part path. */
export function buildCapturedSession(): readonly SessionEvent[] {
  const ev = (seq: number, input: ReturnType<typeof events.userMessage>): SessionEvent =>
    storedEvent(input, { seq, producerId: "trevor-host", createdAt: "2026-07-10T00:00:00.000Z" });
  return [
    ev(1, events.userMessage({ text: "Explain the turn scheduler.", provider: "qwen" })),
    ev(2, events.assistantStarted({ runId: "r1", warm: true, model: "qwen", provider: "qwen" })),
    ev(3, events.assistantThinking({ runId: "r1", text: "The user wants the FIFO gate." })),
    ev(4, events.assistantDelta({ runId: "r1", text: "It runs **one turn at a time** behind a " })),
    ev(5, events.toolStarted({ runId: "r1", callId: "c1", name: "read", arguments: '{"path":"turn.ts"}' })),
    ev(6, events.toolCompleted({ runId: "r1", callId: "c1", name: "read", result: "export function runTurn() {}" })),
    ev(7, events.assistantDelta({ runId: "r1", text: "deferred queue, folding older turns when over budget." })),
    ev(8, events.assistantCompleted({ runId: "r1", text: "It runs **one turn at a time** behind a deferred queue, folding older turns when over budget." })),
  ];
}

/** Fold one captured session to Trevor's transcript rows. Memoized so the runtime is handed a STABLE
 *  array + stable per-row identities on unrelated re-renders - the minimum discipline that keeps the
 *  adapter's `convertMessage` from re-allocating every ThreadMessageLike and defeating Trevor's
 *  per-row structural sharing. */
export function useCapturedTranscript(log: readonly SessionEvent[]): readonly Message[] {
  return useMemo(() => toTranscript(log), [log]);
}

/**
 * The read-only thread: `useExternalStoreRuntime` fed the RAW transcript rows plus `convertMessage`
 * (the adapter converts lazily), `isRunning:false`, and a no-op `onNew` (no send path - the durable
 * log stays the only writer). Mounted under the runtime provider with a minimal `ThreadPrimitive` so
 * the stock primitives render the mapped parts.
 */
export function CapturedSessionThread({ log }: { readonly log: readonly SessionEvent[] }) {
  const messages = useCapturedTranscript(log);
  const runtime = useExternalStoreRuntime({
    isRunning: false,
    messages,
    // Read-only spike: sending is not wired. A real bridge would keep this a no-op and route every
    // mutation through Trevor's transport, never through assistant-ui's composer.
    onNew: async () => {
      throw new Error("read-only spike: no send path");
    },
    convertMessage: transcriptRowToThreadMessage,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Viewport>
          <ThreadPrimitive.Messages
            components={{
              // Only user/assistant text+reasoning render through the stock primitive here; tool-call
              // and every data-trevor-* part need registered components the stock thread lacks - the
              // visible proof of the M3 "lossy view" finding.
              Message: () => (
                <MessagePrimitive.Root>
                  <MessagePrimitive.Parts />
                </MessagePrimitive.Root>
              ),
            }}
          />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
