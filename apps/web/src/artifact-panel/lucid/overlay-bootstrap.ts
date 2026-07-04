import type { LucidAnchor } from "@trevor/session";
import { lucidAnchorRuntime } from "./lucid-anchors";

/**
 * The Lucid OVERLAY bootstrap (plan 27, M3): the script injected INTO the sandboxed artifact iframe
 * to make the artifact addressable. It is the only code with the artifact DOM (the parent Trevor panel
 * is cross-origin from the opaque-origin iframe and cannot reach it), so element/range CAPTURE and
 * version re-RESOLUTION run here, and results cross to the parent only as structured messages via
 * `postMessage`. It embeds `lucidAnchorRuntime` (lucid-anchors.ts) VERBATIM via `String(...)` so the
 * browser overlay and the jsdom anchor tests share one implementation and cannot drift.
 *
 * Isolation: the iframe is mounted `sandbox="allow-scripts"` with NO `allow-same-origin`, giving it an
 * opaque origin. The overlay runs and can `postMessage` out, but neither the overlay nor any
 * artifact-authored script can reach Trevor's app chrome, cookies, or storage - the artifact's CSS/JS
 * can never affect the host document. The overlay's own highlight styles are scoped to a dedicated
 * `#__lucid_overlay` layer, not injected into the artifact's own stylesheet.
 */

/** The wire version tag on every overlay<->parent message, so a forward-compat change is detectable. */
export const LUCID_OVERLAY_WIRE = "lucid-overlay/1";

/** A message the overlay posts OUT to the parent panel. */
export type OverlayOutbound =
  | { readonly v: typeof LUCID_OVERLAY_WIRE; readonly kind: "ready" }
  | {
      readonly v: typeof LUCID_OVERLAY_WIRE;
      readonly kind: "target";
      readonly target: "element" | "range";
      readonly anchor: LucidAnchor;
      readonly snippet: string;
    }
  | {
      readonly v: typeof LUCID_OVERLAY_WIRE;
      readonly kind: "reresolved";
      readonly orphaned: readonly string[];
    };

/** A message the parent posts IN to the overlay. */
export type OverlayInbound =
  | {
      readonly v: typeof LUCID_OVERLAY_WIRE;
      readonly kind: "reresolve";
      readonly anchors: readonly { readonly annotationId: string; readonly anchor: LucidAnchor }[];
    }
  | { readonly v: typeof LUCID_OVERLAY_WIRE; readonly kind: "clear-selection" };

/**
 * Parses an untrusted `MessageEvent.data` into a typed {@link OverlayOutbound}, or null when it is not
 * a well-formed overlay message. The DATA gate half of the trust check; the SOURCE gate
 * ({@link isFromFrame}) must also pass. Pure, so the parent bridge is unit-testable without a real iframe.
 */
export function parseOverlayOutbound(data: unknown): OverlayOutbound | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const m = data as Record<string, unknown>;
  if (m.v !== LUCID_OVERLAY_WIRE) {
    return null;
  }
  if (m.kind === "ready") {
    return { v: LUCID_OVERLAY_WIRE, kind: "ready" };
  }
  if (m.kind === "reresolved") {
    const orphaned = Array.isArray(m.orphaned)
      ? m.orphaned.filter((x): x is string => typeof x === "string")
      : [];
    return { v: LUCID_OVERLAY_WIRE, kind: "reresolved", orphaned };
  }
  if (m.kind === "target" && m.anchor && typeof m.anchor === "object") {
    const target = m.target === "range" ? "range" : "element";
    return {
      v: LUCID_OVERLAY_WIRE,
      kind: "target",
      target,
      anchor: m.anchor as LucidAnchor,
      snippet: typeof m.snippet === "string" ? m.snippet : "",
    };
  }
  return null;
}

/**
 * The SOURCE half of the trust gate: an overlay message is trusted only when it came from THIS
 * artifact iframe's window. The opaque-origin sandbox makes `event.origin` "null", so identity (not
 * origin) is the check - the parent ignores any message whose `source` is not the mounted frame.
 */
export function isFromFrame(eventSource: unknown, frameWindow: Window | null): boolean {
  return frameWindow !== null && eventSource === frameWindow;
}

/** JSON-escapes a string for safe inline embedding in the injected `<script>` (closes off `</script>`
 *  and unicode line separators so authored HTML can never break out of the script literal). */
function jsonForScript(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The injected overlay MAIN, authored as a self-contained function whose ONLY external reference is
 * the embedded {@link lucidAnchorRuntime}. It is never executed in this module; it is stringified into
 * the iframe srcdoc. Keeping it a real (typed) function here means it type-checks with the rest of the
 * web code even though it runs in the artifact realm.
 */
function overlayMain(runtimeFactory: typeof lucidAnchorRuntime, wire: string): void {
  const runtime = runtimeFactory();
  const post = (message: unknown): void => {
    // The opaque-origin sandbox has no same-origin parent to target; "*" is correct here and safe
    // because the payload is inert structured data the parent re-validates by frame identity.
    window.parent.postMessage(message, "*");
  };

  const style = document.createElement("style");
  style.textContent =
    "[data-lucid-hover]{outline:2px solid rgba(59,130,246,.6);outline-offset:1px;cursor:default}" +
    "[data-lucid-picked]{outline:2px solid rgba(59,130,246,.95);background:rgba(59,130,246,.08)}";
  document.head.appendChild(style);

  let hovered: Element | null = null;
  document.addEventListener("mouseover", (event) => {
    const target = event.target as Element | null;
    if (hovered && hovered !== target) {
      hovered.removeAttribute("data-lucid-hover");
    }
    if (target && target !== document.body && target.nodeType === 1) {
      target.setAttribute("data-lucid-hover", "");
      hovered = target;
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (target?.nodeType !== 1) {
      return;
    }
    event.preventDefault();
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const anchor = runtime.captureRangeAnchor(range, document.body);
      if (anchor) {
        post({ v: wire, kind: "target", target: "range", anchor, snippet: anchor.quote });
        return;
      }
    }
    const anchor = runtime.captureElementAnchor(target);
    post({
      v: wire,
      kind: "target",
      target: "element",
      anchor,
      snippet: (target.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
    });
  });

  window.addEventListener("message", (event) => {
    const data = event.data as { v?: string; kind?: string; anchors?: unknown };
    if (!data || data.v !== wire) {
      return;
    }
    if (data.kind === "clear-selection") {
      document.getSelection()?.removeAllRanges();
      return;
    }
    if (data.kind === "reresolve" && Array.isArray(data.anchors)) {
      const orphaned: string[] = [];
      for (const entry of data.anchors as { annotationId: string; anchor: LucidAnchor }[]) {
        const anchor = entry.anchor;
        const ok =
          anchor.type === "element"
            ? runtime.resolveElementAnchor(anchor, document) !== null
            : runtime.resolveRangeAnchor(anchor, document.body) !== null;
        if (!ok) {
          orphaned.push(entry.annotationId);
        }
      }
      post({ v: wire, kind: "reresolved", orphaned });
    }
  });

  post({ v: wire, kind: "ready" });
}

/**
 * Builds the iframe `srcdoc`: the agent's artifact HTML with the overlay bootstrap injected before
 * `</body>` (or appended when the artifact has no body tag). The bootstrap runs the anchor runtime
 * embedded verbatim, so the served bytes on disk / in the blob store are NEVER modified - injection is
 * at mount time only, exactly like Lucid's serve-time overlay injection.
 */
export function buildLucidSrcdoc(html: string): string {
  const script =
    `<script>(${overlayMain.toString()})(${lucidAnchorRuntime.toString()}, ` +
    `${jsonForScript(LUCID_OVERLAY_WIRE)});</script>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${script}</body>`);
  }
  return `${html}${script}`;
}

/** The sandbox token set for the artifact iframe: scripts only, NO same-origin (opaque origin), plus
 *  popups so an artifact link still opens in a new tab. Exported so the surface and its test agree. */
export const LUCID_IFRAME_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";
