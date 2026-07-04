import { activeTurnRunId, type ModelRef, type SessionTransport } from "@trevor/session";
import { useMemo, useState } from "react";
import { useScrollFollow } from "@/hooks/use-scroll-follow";
import {
  sessionTransport,
  useSessionActionsWithTransport,
  useSessionWithTransport,
} from "@/session/use-session";
import type { FoldBackContent } from "./foldback";
import { nextTangentPrompt, tangentTurns } from "./tangent-send";
import { type FoldBackNote, TangentShell } from "./tangent-shell";
import type { ActiveTangent } from "./use-tangent";

/** The model a tangent turn runs on - snapshotted from the parent's active selection at open time. */
export interface TangentTurnModel {
  readonly provider: string;
  readonly reasoning?: string;
  readonly model?: ModelRef;
}

export interface LiveTangentShellProps {
  readonly active: ActiveTangent;
  /** A creation error from {@link useTangent}, shown in the takeover's error state. */
  readonly error: string | null;
  /** A short label for the source (the parent session name). */
  readonly parentLabel?: string;
  /** The model/effort the tangent's turns run on. */
  readonly turnModel: TangentTurnModel;
  readonly onBack: () => void;
  /**
   * Folds a chosen tangent reply back toward the parent for review (M8). Resolves once the content is in
   * the parent composer + the durable marker is recorded; rejects on failure. It is EXPLICIT and
   * reviewable - never an auto-submit, never hidden parent context.
   */
  readonly onFoldBack: (active: ActiveTangent, content: FoldBackContent) => Promise<void> | void;
  /** Injected transport for deterministic tests; defaults to the app's shared session transport. */
  readonly transport?: SessionTransport;
}

/**
 * The LIVE tangent takeover (plan 37, M6): a self-contained surface that owns the TANGENT session's own
 * stream + write actions and its composer, then renders the presentational {@link TangentShell}. Binding a
 * SECOND `useSession`/`useSessionActions` to the tangent's id is exactly what makes the chat isolated -
 * the tangent's transcript is projected from its own log, and its composer publishes into the tangent, so
 * the parent's transcript, send queue, and run state never bleed in (and vice versa). The seed snapshot
 * rides the FIRST prompt (nextTangentPrompt); later prompts are plain.
 */
export function LiveTangentShell({
  active,
  error,
  parentLabel,
  turnModel,
  onBack,
  onFoldBack,
  transport = sessionTransport,
}: LiveTangentShellProps) {
  const stream = useSessionWithTransport(transport, active.tangentSessionId);
  const actions = useSessionActionsWithTransport(transport, active.tangentSessionId);
  const turns = useMemo(() => tangentTurns(stream.events), [stream.events]);
  const [draft, setDraft] = useState("");
  const [foldBackNote, setFoldBackNote] = useState<FoldBackNote | null>(null);
  const scroll = useScrollFollow(turns.length);

  // Busy strictly from the TANGENT's own log - an active run there, or a trailing user turn awaiting a
  // reply. The parent's run state is a different session and never reaches here.
  const activeRun = useMemo(() => activeTurnRunId(stream.events), [stream.events]);
  const awaiting = turns.at(-1)?.role === "user";
  const creating = active.tangentSessionId === null;
  const busy = activeRun !== null || awaiting;
  const disabled = creating || error !== null || busy;

  const onSend = () => {
    const text = nextTangentPrompt(turns, active.quote, draft);
    if (!text.trim()) {
      return;
    }
    setDraft("");
    void actions.publish({
      text,
      provider: turnModel.provider,
      ...(turnModel.reasoning ? { reasoning: turnModel.reasoning } : {}),
      ...(turnModel.model ? { model: turnModel.model } : {}),
    });
    scroll.pinToBottom();
  };

  const handleFoldBack = (content: FoldBackContent) => {
    Promise.resolve(onFoldBack(active, content)).then(
      () =>
        setFoldBackNote({
          tone: "success",
          text: "Sent to the parent composer - review it there before sending.",
        }),
      () => setFoldBackNote({ tone: "error", text: "Couldn't fold back. Try again." }),
    );
  };

  return (
    <TangentShell
      className="h-full"
      sourceQuote={active.quote}
      parentLabel={parentLabel}
      turns={turns}
      error={error}
      busy={busy || creating}
      composer={{
        draft,
        onDraftChange: setDraft,
        onSend,
        disabled,
        placeholder: creating ? "Opening tangent…" : "Ask in this tangent…",
      }}
      onFoldBack={handleFoldBack}
      foldBackNote={foldBackNote}
      onBack={onBack}
      scroll={{
        transcriptRef: scroll.transcriptRef,
        onScroll: scroll.onScroll,
        atBottom: scroll.atBottom,
        onScrollToBottom: scroll.scrollToBottom,
        onUserGesture: scroll.onUserGesture,
      }}
    />
  );
}
