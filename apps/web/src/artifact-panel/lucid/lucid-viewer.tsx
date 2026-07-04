import type { ArtifactRef, LucidFeedbackBatch, LucidReviewState } from "@trevor/session";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { artifactSrc } from "@/blob";
import { LucidChrome } from "./lucid-chrome";
import {
  applyLucidVersion,
  clearLucidQueue,
  commitLucidDraft,
  createLucidPanelState,
  deliverableLucidAnnotations,
  discardLucidDraft,
  editLucidDraftNote,
  hasPendingWork,
  type LucidPanelState,
  lucidVersionArrived,
  removeLucidQueued,
  setLucidReviewStatus,
  targetLucidElement,
} from "./lucid-panel-state";
import { LucidSurface } from "./lucid-surface";

/**
 * The Lucid VIEWER (plan 27, M2/M3/M6/M7): the artifact-panel viewer for a `lucid-html` artifact. It
 * composes the sandboxed {@link LucidSurface} (addressable iframe) with the native {@link LucidChrome}
 * (composer/queue/orphan tray/review), driving the pure {@link LucidPanelState} reducer between them.
 * It fetches the HTML bytes from the blob store, tracks versions across live reloads / deferred swaps,
 * and turns delivered feedback into structured `lucid.feedback` events via the injected wiring - never
 * prompt text.
 */

/** The session-side wiring the app injects so the viewer can persist feedback + review actions as
 *  structured session events, and surface the already-delivered feedback from the fold. */
export interface LucidPanelWiring {
  readonly delivered: LucidReviewState | null;
  readonly onDeliver: (batch: LucidFeedbackBatch) => void;
  readonly onReviewChange: (resolved: boolean) => void;
  /** Test/story override for fetching the artifact HTML (defaults to a blob-store fetch). */
  readonly loadHtml?: (artifact: ArtifactRef) => Promise<string>;
}

export interface LucidViewerProps {
  readonly artifact: ArtifactRef;
  readonly srcOf?: (hash: string) => string;
  readonly lucid?: LucidPanelWiring;
}

const newAnnotationId = (): string =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `ann-${Date.now()}-${Math.random()}`;

async function defaultLoadHtml(
  artifact: ArtifactRef,
  srcOf: (hash: string) => string,
): Promise<string> {
  const res = await fetch(srcOf(artifact.hash));
  if (!res.ok) {
    throw new Error(`Lucid artifact ${artifact.hash} unavailable (${res.status})`);
  }
  return res.text();
}

export function LucidArtifactViewer(props: LucidViewerProps) {
  const { artifact, srcOf = artifactSrc, lucid } = props;
  const meta = artifact.lucid;
  const lucidId = meta?.lucidId ?? artifact.hash;
  const incomingVersion = meta?.version ?? 1;

  const [state, setState] = useState<LucidPanelState>(() =>
    createLucidPanelState({
      lucidId,
      version: incomingVersion,
      reviewStatus: meta?.reviewStatus ?? "open",
    }),
  );
  // The artifact bytes for each version seen, so a DEFERRED swap can keep showing the older version
  // while a committed card is pending, then reload on demand (Lucid D-042/D-055).
  const [htmlByHash, setHtmlByHash] = useState<Record<string, string>>({});
  const [hashByVersion, setHashByVersion] = useState<Record<number, string>>({
    [incomingVersion]: artifact.hash,
  });
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef<Set<string>>(new Set());

  const load = useCallback(
    (ref: ArtifactRef) => {
      if (loadingRef.current.has(ref.hash) || htmlByHash[ref.hash] !== undefined) {
        return;
      }
      loadingRef.current.add(ref.hash);
      const loader = lucid?.loadHtml ? lucid.loadHtml(ref) : defaultLoadHtml(ref, srcOf);
      loader
        .then((html) => setHtmlByHash((prev) => ({ ...prev, [ref.hash]: html })))
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => loadingRef.current.delete(ref.hash));
    },
    [htmlByHash, lucid, srcOf],
  );

  // Fetch the current artifact's bytes.
  useEffect(() => {
    load(artifact);
  }, [artifact, load]);

  // A new version arrived from the session (a fresh lucid.published -> a new artifact ref): record its
  // hash and let the reducer decide live-swap vs deferral.
  useEffect(() => {
    setHashByVersion((prev) =>
      prev[incomingVersion] === artifact.hash
        ? prev
        : { ...prev, [incomingVersion]: artifact.hash },
    );
    setState((prev) => lucidVersionArrived(prev, incomingVersion));
  }, [incomingVersion, artifact.hash]);

  // Sync the review status DOWN from the fold when the human/agent changed it elsewhere (e.g. resume),
  // without clobbering an in-progress local delivery.
  const deliveredStatus = lucid?.delivered?.reviewStatus;
  useEffect(() => {
    if (deliveredStatus) {
      setState((prev) => setLucidReviewStatus(prev, deliveredStatus));
    }
  }, [deliveredStatus]);

  const displayedHash = hashByVersion[state.version] ?? artifact.hash;
  const displayedHtml = htmlByHash[displayedHash] ?? null;

  const reresolveAnchors = useMemo(
    () =>
      state.queue
        .filter((q) => !q.orphaned)
        .map((q) => ({ annotationId: q.annotationId, anchor: q.anchor })),
    [state.queue],
  );

  const handleDeliver = () => {
    const deliverable = deliverableLucidAnnotations(state);
    if (deliverable.length === 0) {
      return;
    }
    const batch: LucidFeedbackBatch = {
      lucidId,
      version: state.version,
      cursor: (lucid?.delivered?.lastCursor ?? 0) + 1,
      annotations: deliverable.map((q) => ({
        annotationId: q.annotationId,
        anchor: q.anchor,
        snippet: q.snippet,
        note: q.note,
      })),
    };
    lucid?.onDeliver(batch);
    setState((prev) => setLucidReviewStatus(clearLucidQueue(prev), "open"));
  };

  const handleApplyVersion = () => {
    const target = state.pendingVersion;
    if (target === null) {
      return;
    }
    // Ensure the new bytes are loaded, then swap; the surface re-resolves committed anchors on mount
    // and reports orphans through onOrphaned. With nothing to re-resolve, apply immediately.
    const nextHash = hashByVersion[target] ?? artifact.hash;
    load({ ...artifact, hash: nextHash });
    if (reresolveAnchors.length === 0) {
      setState((prev) => applyLucidVersion(prev, target, []));
    } else {
      setState((prev) => ({ ...prev, version: target, pendingVersion: null }));
    }
  };

  const handleOrphaned = useCallback((orphanedIds: readonly string[]) => {
    setState((prev) =>
      orphanedIds.length === 0 ? prev : applyLucidVersion(prev, prev.version, orphanedIds),
    );
  }, []);

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <p>This Lucid artifact could not be loaded.</p>
        <a
          href={srcOf(artifact.hash)}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline"
        >
          open the raw HTML externally
        </a>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-lucid-viewer
      data-lucid-id={lucidId}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <LucidSurface
          html={displayedHtml}
          title={meta?.title ?? artifact.name ?? "Lucid artifact"}
          version={state.version}
          reresolve={reresolveAnchors}
          onTarget={(target) =>
            setState((prev) =>
              targetLucidElement(prev, { anchor: target.anchor, snippet: target.snippet }),
            )
          }
          onOrphaned={handleOrphaned}
        />
      </div>
      <LucidChrome
        state={state}
        delivered={lucid?.delivered ?? null}
        onEditNote={(note) => setState((prev) => editLucidDraftNote(prev, note))}
        onCommit={() => setState((prev) => commitLucidDraft(prev, newAnnotationId()))}
        onDiscard={() => setState((prev) => discardLucidDraft(prev))}
        onRemoveQueued={(id) => setState((prev) => removeLucidQueued(prev, id))}
        onDeliver={handleDeliver}
        onApplyVersion={handleApplyVersion}
        onResolve={() => {
          setState((prev) => setLucidReviewStatus(prev, "resolved"));
          lucid?.onReviewChange(true);
        }}
        onReopen={() => {
          setState((prev) => setLucidReviewStatus(prev, "open"));
          lucid?.onReviewChange(false);
        }}
      />
    </div>
  );
}

/** Whether pending work would defer a version swap - re-exported for the panel's dirty guard. */
export { hasPendingWork };
