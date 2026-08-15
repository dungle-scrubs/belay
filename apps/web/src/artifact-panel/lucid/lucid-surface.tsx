import type { LucidAnchor } from "@belay/session";
import { useEffect, useRef } from "react";
import {
  buildLucidSrcdoc,
  isFromFrame,
  LUCID_IFRAME_SANDBOX,
  LUCID_OVERLAY_WIRE,
  type OverlayOutbound,
  parseOverlayOutbound,
} from "./overlay-bootstrap";

/**
 * The Lucid SURFACE (plan 27, M3): the artifact rendered in a strictly-isolated sandboxed iframe with
 * the addressability overlay injected over it. The iframe is `sandbox="allow-scripts"` with NO
 * `allow-same-origin`, so it runs on an OPAQUE origin: artifact CSS/JS can never touch Belay's app
 * chrome, cookies, or storage, and the overlay reaches the parent only through `postMessage`. The
 * parent trusts an inbound message ONLY when it comes from THIS frame's window (identity, since the
 * opaque origin is "null") and parses as a well-formed overlay message; everything else is ignored.
 *
 * Targeting/annotation state lives in the parent reducer; this component is the DOM bridge only.
 */

export interface LucidTarget {
  readonly kind: "element" | "range";
  readonly anchor: LucidAnchor;
  readonly snippet: string;
}

export interface LucidSurfaceProps {
  readonly html: string | null;
  readonly title: string;
  /** Bumped on a version swap so the srcDoc remounts (fresh DOM + overlay), then re-resolution runs. */
  readonly version: number;
  /** The committed annotations to re-resolve against the (current) artifact DOM once the overlay is
   *  ready - the overlay returns the ids it could no longer attach so the parent can orphan them. */
  readonly reresolve?: readonly { readonly annotationId: string; readonly anchor: LucidAnchor }[];
  readonly onTarget: (target: LucidTarget) => void;
  readonly onOrphaned?: (annotationIds: readonly string[]) => void;
}

export function LucidSurface(props: LucidSurfaceProps) {
  const { html, title, version, reresolve, onTarget, onOrphaned } = props;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Keep the latest callbacks/anchors in refs so the message listener is installed once, not
  // re-bound on every keystroke-driven re-render (which would drop in-flight overlay messages).
  const onTargetRef = useRef(onTarget);
  const onOrphanedRef = useRef(onOrphaned);
  const reresolveRef = useRef(reresolve);
  onTargetRef.current = onTarget;
  onOrphanedRef.current = onOrphaned;
  reresolveRef.current = reresolve;

  useEffect(() => {
    const handle = (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow ?? null;
      if (!isFromFrame(event.source, frameWindow)) {
        return;
      }
      const message: OverlayOutbound | null = parseOverlayOutbound(event.data);
      if (!message) {
        return;
      }
      if (message.kind === "ready") {
        const anchors = reresolveRef.current ?? [];
        if (anchors.length > 0) {
          frameWindow?.postMessage({ v: LUCID_OVERLAY_WIRE, kind: "reresolve", anchors }, "*");
        }
      } else if (message.kind === "target") {
        onTargetRef.current({
          kind: message.target,
          anchor: message.anchor,
          snippet: message.snippet,
        });
      } else if (message.kind === "reresolved") {
        onOrphanedRef.current?.(message.orphaned);
      }
    };
    window.addEventListener("message", handle);
    return () => window.removeEventListener("message", handle);
  }, []);

  if (html === null) {
    return (
      <div className="flex min-h-[24rem] flex-1 items-center justify-center bg-background text-muted-foreground text-sm">
        loading Lucid artifact…
      </div>
    );
  }

  return (
    <iframe
      key={version}
      ref={frameRef}
      title={title}
      // The overlay is injected at MOUNT time; the on-disk / stored artifact bytes are never modified.
      srcDoc={buildLucidSrcdoc(html)}
      sandbox={LUCID_IFRAME_SANDBOX}
      data-lucid-surface
      className="h-full min-h-[24rem] w-full flex-1 border-0 bg-white"
    />
  );
}
