import { useBoolean } from "ahooks";
import DOMPurify from "dompurify";
import { Code2, Copy, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
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

export const renderMermaidDiagram: MermaidRender = async (id, source) => {
  const mermaidModule = await import("mermaid");
  const mermaid = mermaidModule.default;
  mermaid.initialize({
    deterministicIds: true,
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace",
    securityLevel: "strict",
    startOnLoad: false,
    theme: "base",
    themeVariables: createMermaidThemeVariables(),
  });
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
  const [zoom, setZoom] = useState(1);
  const svgStyle: MermaidSvgStyle = useMemo(() => ({ "--trevor-mermaid-zoom": zoom }), [zoom]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
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
    }, 0);

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
    </figure>
  );
}
