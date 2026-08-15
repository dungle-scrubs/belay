import type { SessionSummary, TangentAnchorSeed } from "@belay/session";
import { useCallback, useRef, useState } from "react";
import type { TangentSelection } from "@/components/assistant-ui/quote-selection-toolbar";
import { createTangentSession } from "@/session/use-session";

/**
 * The active tangent the takeover is showing (plan 37, M5). `tangentSessionId` is null while the session
 * is being created (the takeover opens optimistically with the seed context) and stays null on a creation
 * failure (the shell then shows the error). Everything else derives from the durable session metadata, so
 * a reconnect/reload re-resolves the tangent from its own log rather than this transient state.
 */
export interface ActiveTangent {
  readonly tangentSessionId: string | null;
  readonly parentSessionId: string;
  readonly sourceMessageId: string;
  readonly quote: string;
}

export interface TangentController {
  readonly active: ActiveTangent | null;
  /** A creation/transport error for the active tangent, shown in the takeover's error state. */
  readonly error: string | null;
  /** Open a tangent from a selection (M3 payload) branched off `parentSessionId`. */
  readonly open: (selection: TangentSelection, parentSessionId: string) => void;
  /** Reopen an EXISTING tangent from its inventory summary (discovery, M7) - no new session is created. */
  readonly openExisting: (tangent: SessionSummary) => void;
  readonly close: () => void;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Couldn't create the tangent session.";
}

/**
 * Owns the tangent lifecycle for the app shell: opening a tangent from a selection creates an isolated
 * child session (via the injected `create`, defaulting to the real transport) and drives the takeover.
 * The takeover opens immediately with the seed context; the session id fills in when creation resolves.
 * A synchronous re-entrancy guard makes a double-click open exactly one tangent (M5). `create` is
 * injectable so hook tests drive it against a recording transport without a live store.
 */
export function useTangent(
  opts: { readonly create?: (anchor: TangentAnchorSeed) => Promise<string> } = {},
): TangentController {
  const create = opts.create ?? createTangentSession;
  const [active, setActive] = useState<ActiveTangent | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards a duplicate click synchronously (before the async create resolves): one takeover at a time.
  const openRef = useRef(false);

  const open = useCallback(
    (selection: TangentSelection, parentSessionId: string) => {
      if (openRef.current) {
        return;
      }
      if (!selection.sourceMessageId) {
        setError("This selection has no single source message.");
        return;
      }
      openRef.current = true;
      setError(null);
      const anchor: TangentAnchorSeed = {
        parentSessionId,
        sourceMessageId: selection.sourceMessageId,
        quote: selection.text,
      };
      setActive({
        tangentSessionId: null,
        parentSessionId,
        sourceMessageId: selection.sourceMessageId,
        quote: selection.text,
      });
      create(anchor).then(
        (tangentSessionId) =>
          setActive((current) => (current ? { ...current, tangentSessionId } : current)),
        (cause) => setError(errorText(cause)),
      );
    },
    [create],
  );

  const openExisting = useCallback((tangent: SessionSummary) => {
    if (openRef.current || !tangent.tangentOf) {
      return;
    }
    openRef.current = true;
    setError(null);
    // No create: the session already exists, so its stream + metadata drive the takeover directly.
    setActive({
      tangentSessionId: tangent.sessionId,
      parentSessionId: tangent.tangentOf.parentSessionId,
      sourceMessageId: tangent.tangentOf.sourceMessageId,
      quote: tangent.tangentOf.quote,
    });
  }, []);

  const close = useCallback(() => {
    openRef.current = false;
    setActive(null);
    setError(null);
  }, []);

  return { active, error, open, openExisting, close };
}
