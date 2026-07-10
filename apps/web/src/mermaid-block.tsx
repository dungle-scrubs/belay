import { useBoolean, useEventListener } from "ahooks";
import DOMPurify from "dompurify";
import { Code2, Copy, Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import { copyText } from "@/lib/clipboard";

type RenderState =
  | { readonly status: "loading" }
  | { readonly status: "rendered"; readonly svg: string }
  | { readonly status: "error"; readonly message: string };

export type MermaidRender = (id: string, source: string) => Promise<string>;

interface MermaidSvgStyle extends CSSProperties {
  readonly "--trevor-mermaid-zoom": number;
}

type MermaidThemeVariables = Record<string, string>;

interface MermaidRenderConfig {
  readonly deterministicIds: true;
  readonly flowchart: {
    readonly curve: "basis";
    readonly diagramPadding: number;
    readonly inheritDir: true;
    readonly nodeSpacing: number;
    readonly rankSpacing: number;
    readonly subGraphTitleMargin: {
      readonly bottom: number;
      readonly top: number;
    };
    readonly wrappingWidth: number;
  };
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly htmlLabels: false;
  readonly securityLevel: "strict";
  readonly startOnLoad: false;
  readonly theme: "base";
  readonly themeVariables: MermaidThemeVariables;
}

const MERMAID_THEME_TOKEN_NAMES = {
  background: "--background",
  border: "--border",
  foreground: "--foreground",
  mutedForeground: "--muted-foreground",
  smuiSurface1: "--smui-surface-1",
  smuiSurface2: "--smui-surface-2",
} as const;

const MERMAID_THEME_FALLBACKS = {
  background: "#1a1e23",
  border: "#3b414b",
  foreground: "#bdc9d8",
  mutedForeground: "#8993a0",
  smuiSurface1: "#21252e",
  smuiSurface2: "#292e38",
} as const;

const MERMAID_RENDER_DEBOUNCE_MS = 350;

function currentDocumentStyles(): Pick<CSSStyleDeclaration, "getPropertyValue"> | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }

  return window.getComputedStyle(document.documentElement);
}

function hslComponentsToHex(value: string): string | null {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (match === null) {
    return null;
  }

  const hue = (((Number(match[1]) % 360) + 360) % 360) / 60;
  const saturation = Number(match[2]) / 100;
  const lightness = Number(match[3]) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const m = lightness - chroma / 2;
  const [red, green, blue] =
    hue < 1
      ? [chroma, x, 0]
      : hue < 2
        ? [x, chroma, 0]
        : hue < 3
          ? [0, chroma, x]
          : hue < 4
            ? [0, x, chroma]
            : hue < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];

  return `#${[red, green, blue]
    .map((channel) =>
      Math.round((channel + m) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function resolveHslToken(
  styles: Pick<CSSStyleDeclaration, "getPropertyValue"> | null,
  tokenName: string,
  fallback: string,
): string {
  if (styles === null) {
    return fallback;
  }

  const resolved = hslComponentsToHex(styles.getPropertyValue(tokenName));
  return resolved ?? fallback;
}

export function createMermaidThemeVariables(
  styles: Pick<CSSStyleDeclaration, "getPropertyValue"> | null = currentDocumentStyles(),
): MermaidThemeVariables {
  const background = resolveHslToken(
    styles,
    MERMAID_THEME_TOKEN_NAMES.background,
    MERMAID_THEME_FALLBACKS.background,
  );
  const border = resolveHslToken(
    styles,
    MERMAID_THEME_TOKEN_NAMES.border,
    MERMAID_THEME_FALLBACKS.border,
  );
  const foreground = resolveHslToken(
    styles,
    MERMAID_THEME_TOKEN_NAMES.foreground,
    MERMAID_THEME_FALLBACKS.foreground,
  );
  const mutedForeground = resolveHslToken(
    styles,
    MERMAID_THEME_TOKEN_NAMES.mutedForeground,
    MERMAID_THEME_FALLBACKS.mutedForeground,
  );
  const smuiSurface1 = resolveHslToken(
    styles,
    MERMAID_THEME_TOKEN_NAMES.smuiSurface1,
    MERMAID_THEME_FALLBACKS.smuiSurface1,
  );
  const smuiSurface2 = resolveHslToken(
    styles,
    MERMAID_THEME_TOKEN_NAMES.smuiSurface2,
    MERMAID_THEME_FALLBACKS.smuiSurface2,
  );

  return {
    actorBkg: smuiSurface1,
    actorBorder: border,
    actorTextColor: foreground,
    classText: foreground,
    edgeLabelBackground: background,
    fontSize: "13px",
    lineColor: mutedForeground,
    mainBkg: smuiSurface1,
    nodeBorder: border,
    noteBkgColor: smuiSurface2,
    noteTextColor: foreground,
    primaryBorderColor: border,
    primaryColor: smuiSurface1,
    primaryTextColor: foreground,
    secondaryBorderColor: border,
    secondaryColor: smuiSurface2,
    secondaryTextColor: foreground,
    tertiaryBorderColor: border,
    tertiaryColor: background,
    tertiaryTextColor: foreground,
  };
}

export function createMermaidRenderConfig(): MermaidRenderConfig {
  return {
    deterministicIds: true,
    flowchart: {
      curve: "basis",
      diagramPadding: 18,
      inheritDir: true,
      nodeSpacing: 28,
      rankSpacing: 54,
      subGraphTitleMargin: {
        bottom: 12,
        top: 10,
      },
      wrappingWidth: 190,
    },
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace",
    fontSize: 13,
    htmlLabels: false,
    securityLevel: "strict",
    startOnLoad: false,
    theme: "base",
    themeVariables: createMermaidThemeVariables(),
  };
}

// Theme signal the render config depends on. The app currently pins the dark
// class at startup (see main.tsx), but keying on the live signals keeps the
// cache correct if a runtime theme toggle ever lands: any change to the root
// element's dark class or the OS color scheme produces a new key, which
// invalidates the cached config and forces one re-initialize.
function currentMermaidThemeKey(): string {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return "ssr";
  }

  const rootIsDark = document.documentElement.classList.contains("dark");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return `${rootIsDark ? "dark" : "light"}:${prefersDark ? "os-dark" : "os-light"}`;
}

// mermaid.initialize resets internal parser/renderer state and our config
// build walks ~20 getComputedStyle token lookups, so both are per-theme work,
// not per-diagram work. Cache the last initialized theme key at module level
// and skip initialize entirely while the theme is unchanged.
let initializedMermaidThemeKey: string | null = null;

export const renderMermaidDiagram: MermaidRender = async (id, source) => {
  const mermaidModule = await import("mermaid");
  const mermaid = mermaidModule.default;
  const themeKey = currentMermaidThemeKey();
  if (initializedMermaidThemeKey !== themeKey) {
    mermaid.initialize(createMermaidRenderConfig());
    initializedMermaidThemeKey = themeKey;
  }
  const result = await mermaid.render(id, source);
  return result.svg;
};

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Mermaid rendering failure";
}

function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
  });
}

export function MermaidBlock({
  source,
  renderDiagram = renderMermaidDiagram,
}: {
  readonly source: string;
  readonly renderDiagram?: MermaidRender;
}) {
  const reactId = useId();
  const renderId = useMemo(
    () => `trevor-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId],
  );
  const [state, setState] = useState<RenderState>({ status: "loading" });
  const [sourceOpen, { toggle: toggleSource }] = useBoolean(false);
  const [fullscreenOpen, { setFalse: closeFullscreen, setTrue: openFullscreen }] =
    useBoolean(false);
  const [zoom, setZoom] = useState(1);
  const svgStyle: MermaidSvgStyle = useMemo(() => ({ "--trevor-mermaid-zoom": zoom }), [zoom]);

  useEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        closeFullscreen();
      }
    },
    {
      enable: fullscreenOpen,
      target: () => document,
    },
  );

  useEffect(() => {
    if (state.status !== "rendered" && fullscreenOpen) {
      closeFullscreen();
    }
  }, [closeFullscreen, fullscreenOpen, state.status]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      renderDiagram(renderId, source)
        .then((svg) => {
          if (!cancelled) {
            setState({ status: "rendered", svg: sanitizeSvg(svg) });
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setState({ status: "error", message: messageFromError(error) });
          }
        });
    }, MERMAID_RENDER_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [renderDiagram, renderId, source]);

  const copySource = () => {
    void copyText(source);
  };

  return (
    <figure className="trevor-mermaid" data-testid="mermaid-block">
      <div className="trevor-mermaid__toolbar">
        <span className="trevor-mermaid__label">Mermaid</span>
        <div className="trevor-mermaid__actions">
          <button
            type="button"
            aria-label="Copy Mermaid source"
            title="Copy Mermaid source"
            onClick={copySource}
          >
            <Copy aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Toggle Mermaid source"
            title="Toggle Mermaid source"
            onClick={toggleSource}
          >
            <Code2 aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Zoom Mermaid diagram out"
            title="Zoom Mermaid diagram out"
            onClick={() => setZoom((value) => Math.max(0.6, Number((value - 0.1).toFixed(1))))}
          >
            <ZoomOut aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Reset Mermaid diagram zoom"
            title="Reset Mermaid diagram zoom"
            onClick={() => setZoom(1)}
          >
            <RotateCcw aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Zoom Mermaid diagram in"
            title="Zoom Mermaid diagram in"
            onClick={() => setZoom((value) => Math.min(1.8, Number((value + 0.1).toFixed(1))))}
          >
            <ZoomIn aria-hidden="true" />
          </button>
          {state.status === "rendered" ? (
            <button
              type="button"
              aria-label="Open Mermaid diagram fullscreen"
              title="Open Mermaid diagram fullscreen"
              onClick={openFullscreen}
            >
              <Maximize2 aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="trevor-mermaid__canvas" aria-live="polite">
        {state.status === "loading" ? (
          <div className="trevor-mermaid__loading">Rendering diagram...</div>
        ) : null}
        {state.status === "rendered" ? (
          <div
            className="trevor-mermaid__svg"
            style={svgStyle}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid SVG is sanitized with DOMPurify before insertion.
            dangerouslySetInnerHTML={{ __html: state.svg }}
          />
        ) : null}
        {state.status === "error" ? (
          <div className="trevor-mermaid__error" role="alert">
            <strong>Mermaid could not render this diagram.</strong>
            <span>{state.message}</span>
          </div>
        ) : null}
      </div>
      {sourceOpen || state.status === "error" ? (
        <pre className="trevor-mermaid__source" data-testid="mermaid-source">
          {source}
        </pre>
      ) : (
        <pre
          className="trevor-mermaid__source trevor-mermaid__source--collapsed"
          data-testid="mermaid-source"
        >
          {source}
        </pre>
      )}
      {state.status === "rendered" && fullscreenOpen ? (
        <div
          className="trevor-mermaid__fullscreen"
          role="dialog"
          aria-modal="true"
          aria-label="Mermaid diagram fullscreen viewer"
        >
          <div className="trevor-mermaid__fullscreen-toolbar">
            <span className="trevor-mermaid__label">Mermaid</span>
            <div className="trevor-mermaid__actions">
              <button
                type="button"
                aria-label="Zoom fullscreen Mermaid diagram out"
                title="Zoom out"
                onClick={() => setZoom((value) => Math.max(0.6, Number((value - 0.1).toFixed(1))))}
              >
                <ZoomOut aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Reset fullscreen Mermaid diagram zoom"
                title="Reset zoom"
                onClick={() => setZoom(1)}
              >
                <RotateCcw aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Zoom fullscreen Mermaid diagram in"
                title="Zoom in"
                onClick={() => setZoom((value) => Math.min(1.8, Number((value + 0.1).toFixed(1))))}
              >
                <ZoomIn aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Close Mermaid fullscreen viewer"
                title="Close"
                onClick={closeFullscreen}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="trevor-mermaid__fullscreen-canvas">
            <div
              className="trevor-mermaid__svg trevor-mermaid__svg--fullscreen"
              style={svgStyle}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid SVG is sanitized with DOMPurify before insertion.
              dangerouslySetInnerHTML={{ __html: state.svg }}
            />
          </div>
        </div>
      ) : null}
    </figure>
  );
}
