import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ArtifactSource,
  createTrevorClient,
  type TranscriptEntry,
  type TrevorClient,
} from "@belay/sdk";
import {
  type ArtifactRef,
  decodeTrevorEvent,
  PRODUCER_IDS,
  type SessionEvent,
  type SessionTransport,
} from "@belay/session";
import { testIdentity } from "@belay/session/testing";
import { type BootedBlob, bootBlob, bootStore } from "@belay/test-kit/boot";
import { publishTurn } from "@host/agent/turn";
import { interruptFiber } from "@host/effect/fiber-exit";
import type { ChatMessage, Provider } from "@host/providers";
import { Effect, Fiber } from "effect";
import { fakeProvider, transportEmit } from "./fake-provider";

/** The booted session-store handle test-kit returns (derived so the host needs no `@belay/server-kit` dep). */
type BootedStore = Awaited<ReturnType<typeof bootStore>>;

/**
 * The eval/automation harness (plan 28 M10): drive Belay end-to-end through the SAME `@belay/sdk`
 * headless workflow layer an external eval or automation would use, and get back a structured run record
 * to score. It boots the real local stores (test-kit owns that lifecycle), binds an SDK client, and - in
 * the deterministic `fake` lane - attaches a minimal fake-provider host that reacts to the client's
 * prompts exactly the way `main.ts`'s inbound lane does (schedule a turn per answerable `user.message`,
 * tear it down on `user.cancel`). The `live` lane attaches no fake host; the caller points the harness at
 * a real host and the prerequisites are GATED with an explicit skip reason (never a silent pass).
 *
 * Responsible for: composing stores + SDK client + a scriptable fake host into a `run() -> RunRecord`
 * loop, plus the live-lane availability gate.
 * Not for: the SDK workflows themselves (packages/sdk) or the store lifecycle (test-kit/boot).
 */

/** A single fake host that reacts to the SDK client's prompts by driving a real turn per answerable message. */
export interface FakeHostHandle {
  close(): void;
}

/**
 * Attaches a minimal reactive host over the transport: for each answerable `user.message` (one not
 * authored by the host itself) it schedules a `publishTurn` fiber emitting to the durable log, and on a
 * `user.cancel` it interrupts the matching run's fiber - which makes `publishTurn`'s own `onExit` emit the
 * terminal `assistant.completed { cancelled: true }` (interpretFiberExit maps an interrupted fiber to
 * `cancelled`), the D-094 cancel signal a viewer/SDK/CLI observes. Mirrors `main.ts`'s live-leader arms
 * without the real lease/registry, so an e2e can drive prompt/stream/cancel against a real store.
 */
export function attachFakeHost(
  transport: SessionTransport,
  sessionId: string,
  providerFor: () => Provider,
): FakeHostHandle {
  const hostProducer = PRODUCER_IDS.host;
  const handled = new Set<number>();
  const active = new Map<string, Fiber.RuntimeFiber<void, never>>();
  const history: ChatMessage[] = [];
  const emitLayer = transportEmit(transport, sessionId, hostProducer);

  const connection = transport.connectSession({
    sessionId,
    identity: testIdentity("eval-fake-host"),
    afterSeq: 0,
    onEvent: (event) => {
      const decoded = decodeTrevorEvent(event);
      if (
        event.type === "user.message" &&
        event.producerId !== hostProducer &&
        !handled.has(event.seq)
      ) {
        handled.add(event.seq);
        history.push({ role: "user", content: String(event.payload.text ?? "") });
        const runId = `r${event.seq}`;
        const fiber = Effect.runFork(
          publishTurn(providerFor(), [...history], { runId }).pipe(Effect.provide(emitLayer)),
        );
        active.set(runId, fiber);
        void Effect.runPromise(Fiber.await(fiber)).finally(() => active.delete(runId));
      } else if (decoded?.type === "assistant.completed") {
        history.push({ role: "assistant", content: decoded.text });
      } else if (decoded?.type === "user.cancel") {
        for (const [runId, fiber] of active) {
          if (!decoded.runId || decoded.runId === runId) {
            interruptFiber(fiber);
          }
        }
      }
    },
  });

  return {
    close: () => {
      for (const fiber of active.values()) {
        interruptFiber(fiber);
      }
      connection.close();
    },
  };
}

/** One scored run's inputs: the prompt text plus how the fake provider should answer it. */
export interface EvalRunInput {
  readonly text: string;
  /** The provider that answers this turn (defaults to the standard fake tool-then-answer provider). */
  readonly provider?: Provider;
  /** Artifacts to attach to the prompt (uploaded separately via {@link EvalHarness.uploadArtifact}). */
  readonly artifacts?: readonly ArtifactRef[];
  /** How long to wait for the turn to complete before returning `timedOut` (default 5s in the fake lane). */
  readonly timeoutMs?: number;
  /** When set, publish `user.cancel` once the turn has started, to exercise the D-094 cancel path. */
  readonly cancel?: boolean;
}

/** A structured record of one run, suitable for eval scoring (no rendering, just the facts). */
export interface EvalRunRecord {
  readonly runId: string | null;
  readonly text: string;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  /** Every correlated event of the turn, in order (raw access for finer scoring). */
  readonly events: readonly SessionEvent[];
  /** The folded transcript of the whole session after this run. */
  readonly transcript: readonly TranscriptEntry[];
}

export interface EvalHarness {
  readonly client: TrevorClient;
  readonly store: BootedStore;
  readonly blob: BootedBlob;
  /** Uploads bytes to the booted blob store and returns a ref a run can attach to its prompt. */
  uploadArtifact(source: ArtifactSource, mimeType: string): Promise<ArtifactRef>;
  /** Submits one prompt, drives the turn, and returns a structured record. */
  run(input: EvalRunInput): Promise<EvalRunRecord>;
  /** Stops the fake host (if any) and both stores. */
  close(): Promise<void>;
}

const DEFAULT_FAKE_TIMEOUT_MS = 5_000;

/**
 * Boots the deterministic (`fake`) eval harness: real stores + SDK client + an attached fake-provider
 * host. `run()` submits through the SDK and returns a structured record. The session id is stable across
 * `run()` calls so the fake host carries multi-turn history.
 */
export async function createFakeEvalHarness(sessionId = "eval"): Promise<EvalHarness> {
  const store = await bootStore();
  const blob = await bootBlob();
  const client = createTrevorClient({ sessionUrl: store.url, blobUrl: blob.url });
  await client.ensureSession(sessionId);

  let currentProvider: Provider = fakeProvider();
  const host = attachFakeHost(client.transport, sessionId, () => currentProvider);

  return {
    client,
    store,
    blob,
    uploadArtifact: (source, mimeType) => client.uploadArtifact(source, mimeType),
    run: async (input) => {
      currentProvider = input.provider ?? fakeProvider();
      const head = await client.readLog(sessionId);
      const afterSeq = head.length ? (head[head.length - 1]?.seq ?? 0) : 0;

      let runId: string | null = null;
      const turn = client.streamTurn(sessionId, {
        afterSeq,
        timeoutMs: input.timeoutMs ?? DEFAULT_FAKE_TIMEOUT_MS,
        onEvent: (event) => {
          const decoded = decodeTrevorEvent(event);
          if (decoded?.type === "assistant.started" && runId === null) {
            runId = decoded.runId;
            if (input.cancel) {
              void client.cancel(sessionId, runId).catch(() => {});
            }
          }
        },
      });
      await client.prompt(sessionId, {
        text: input.text,
        provider: "fake",
        ...(input.artifacts ? { artifacts: input.artifacts } : {}),
      });
      const result = await turn;
      const transcript = await client.readTranscript(sessionId);
      return {
        runId: result.runId,
        text: result.text,
        cancelled: result.cancelled,
        timedOut: result.timedOut,
        events: result.events,
        transcript: transcript.entries,
      };
    },
    close: async () => {
      host.close();
      await blob.close();
      await store.close();
    },
  };
}

/** Whether the live-provider lane can run, with a stated reason when it cannot (never a silent skip). */
export interface LiveLaneStatus {
  readonly available: boolean;
  readonly reason: string;
}

/**
 * Gates the live-provider eval lane on its prerequisites: LM Studio reachable via `LMSTUDIO_URL`, or cloud
 * credentials in `~/.pi/auth.json`. A test calls this and skips with `status.reason` when unavailable, so
 * the live lane never silently passes and never fails the hermetic run.
 */
export function liveLaneStatus(): LiveLaneStatus {
  if (process.env.LMSTUDIO_URL) {
    return { available: true, reason: "LMSTUDIO_URL is set" };
  }
  if (existsSync(join(homedir(), ".pi", "auth.json"))) {
    return { available: true, reason: "~/.pi/auth.json present" };
  }
  return {
    available: false,
    reason: "no live provider: set LMSTUDIO_URL or provide ~/.pi/auth.json",
  };
}
