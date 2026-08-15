import {
  decodeTrevorEvent,
  type SessionEvent,
  events as sessionEvents,
  type TrevorEventInput,
} from "@belay/session";
import type { Lease } from "@host/session/lease";
import { warn } from "@host/transport/log";
import type { EmitEvent } from "@host/transport/services";
import { Cause, Effect } from "effect";
import type { ChatMessage, Provider, ProviderError } from "../providers";
import type { CompactionController } from "./compaction-controller";
import type { ConversationLog } from "./conversation-log";
import { distillToBudget } from "./tool-less-summary";

/**
 * Session auto-titling (plan 58.6.4 A13): an un-renamed session earns ONE generated title on its
 * first real assistant turn, instead of showing the truncated first prompt. This reuses the existing
 * `session.title` event (the same one a manual rename emits) and the tool-less `distillToBudget`
 * primitive; it builds no new infrastructure and yields entirely to a manual rename (latest-wins).
 *
 * Responsible for: the once-only auto-title gate, the tool-less title job + its prompt/sanitize, and
 * the emit decision (a failed/garbled title emits nothing so the derived title stands).
 * Not for: the manual rename UX (web) or the inventory title projection (packages/session).
 */

/** A short title: a handful of words, so a tiny token budget and a 60-char cap (the inventory's). */
const TITLE_TOKEN_BUDGET = 16;
const TITLE_CHAR_CAP = 60;

/**
 * The auto-title gate. True iff the durable log carries NO `session.title` yet - so a manual rename,
 * past or future, always wins (latest-wins) - AND exactly one non-empty `assistant.completed` has
 * landed: the first real turn. Later turns leave the first-turn title alone (no re-titling on topic
 * shift), and a blank/errored completion never counts toward the first turn.
 */
export function needsAutoTitle(events: readonly SessionEvent[]): boolean {
  let completedTurns = 0;
  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    if (!decoded) {
      continue;
    }
    if (decoded.type === "session.title") {
      return false;
    }
    if (decoded.type === "assistant.completed" && decoded.text.trim()) {
      completedTurns++;
    }
  }
  return completedTurns === 1;
}

/**
 * Builds the tool-less title prompt: one user message asking for a short, specific title over the
 * turn transcript. A mechanical extraction pass (cheapest reasoning, like the compaction summarizer),
 * not open thinking.
 */
export function buildTitlePrompt(history: readonly ChatMessage[]): ChatMessage[] {
  const transcript = history.map((message) => `${message.role}: ${message.content}`).join("\n\n");
  return [
    {
      role: "user",
      content:
        "Write a short, specific title for the conversation below - at most 6 words, in Title " +
        "Case, with no surrounding quotes and no trailing punctuation. Reply with only the title.\n\n" +
        `[Conversation]\n${transcript}`,
    },
  ];
}

/**
 * Normalizes a raw model title to a single clean line: first line only, surrounding quotes/backticks
 * stripped, whitespace collapsed, trailing punctuation trimmed, capped. Returns "" for an empty or
 * garbled result, which is the signal to emit nothing and keep the derived fallback title.
 */
export function sanitizeTitle(raw: string): string {
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  const cleaned = firstLine
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?]+$/, "")
    .trim();
  return cleaned.length > TITLE_CHAR_CAP ? cleaned.slice(0, TITLE_CHAR_CAP).trim() : cleaned;
}

/**
 * The tool-less title job: distill the turn transcript to a short title at the cheapest reasoning
 * level and a tiny token budget. The raw result is sanitized by {@link autoTitleEvent} before the
 * caller decides whether to emit.
 */
export function distillTitle(
  provider: Provider,
  history: readonly ChatMessage[],
): Effect.Effect<string, ProviderError> {
  return distillToBudget(provider, buildTitlePrompt(history), {
    tokenBudget: TITLE_TOKEN_BUDGET,
    charCap: TITLE_CHAR_CAP,
  });
}

/**
 * The `session.title` event for a generated title, or null when the sanitized title is empty (a
 * failed/garbled job emits nothing). Keeps the emit-or-not decision in one testable place.
 */
export function autoTitleEvent(rawTitle: string): TrevorEventInput | null {
  const title = sanitizeTitle(rawTitle);
  return title ? sessionEvents.sessionTitle({ title }) : null;
}

/** The live host state the auto-titler reads: the provider seam, the durable log, and liveness. */
export interface AutoTitleDeps {
  /** Publish one host-authored event to the durable log (main.ts's emit). */
  readonly emit: EmitEvent;
  /** The provider the title job runs on: the last turn's, else the registry default. */
  readonly compactionController: Pick<CompactionController, "providerOrDefault">;
  /** The durable events (for the gate) + the prompt projection (for the transcript). */
  readonly conversationLog: Pick<ConversationLog, "eventsSnapshot" | "history">;
  /** Whether replay has completed and the host is answering (main.ts's mutable `live` flag). */
  live(): boolean;
  /** The lease: only the leader titles. */
  readonly lease: Pick<Lease, "isLeader">;
}

/**
 * Builds the auto-title lane over the host's live state; main.ts calls `maybeAutoTitle()` from the
 * `assistant.completed` branch. Fires the title job at most once per host process (the re-entrancy
 * guard), only for a live leader whose log passes the gate and has a provider - the fold's own echo
 * lands the `session.title` through the normal path. A failed/empty job emits nothing.
 */
export function makeAutoTitler(deps: AutoTitleDeps) {
  const { emit, compactionController, conversationLog, live, lease } = deps;

  // At most one title job per host process: the gate also blocks re-titling across restarts (a prior
  // title is in the log), but this stops a second job launching before the first job's event lands.
  let attempted = false;

  function maybeAutoTitle(): void {
    if (attempted || !live() || !lease.isLeader()) {
      return;
    }
    if (!needsAutoTitle(conversationLog.eventsSnapshot())) {
      return;
    }
    const provider = compactionController.providerOrDefault();
    if (!provider) {
      return;
    }
    attempted = true;
    const history = conversationLog.history();
    Effect.runFork(
      distillTitle(provider, history).pipe(
        Effect.flatMap((raw) => {
          const event = autoTitleEvent(raw);
          // A failed/empty title emits nothing: the first-prompt-derived title stands.
          return event ? Effect.promise(() => emit(event)) : Effect.void;
        }),
        Effect.catchAllCause((cause) =>
          Effect.sync(() => warn("host", "auto-title failed", { cause: Cause.pretty(cause) })),
        ),
      ),
    );
  }

  return { maybeAutoTitle };
}

/** The factory's product surface, so consumers derive the signature instead of re-declaring it. */
export type AutoTitlerApi = ReturnType<typeof makeAutoTitler>;
