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

const MERMAID_THEME_VARIABLES = {
  actorBkg: "hsl(var(--smui-surface-1))",
  actorBorder: "hsl(var(--border))",
  actorTextColor: "hsl(var(--foreground))",
  classText: "hsl(var(--foreground))",
  edgeLabelBackground: "hsl(var(--background))",
  lineColor: "hsl(var(--muted-foreground))",
  mainBkg: "hsl(var(--smui-surface-1))",
  nodeBorder: "hsl(var(--border))",
  noteBkgColor: "hsl(var(--smui-surface-2))",
  noteTextColor: "hsl(var(--foreground))",
  primaryBorderColor: "hsl(var(--border))",
  primaryColor: "hsl(var(--smui-surface-1))",
  primaryTextColor: "hsl(var(--foreground))",
  secondaryBorderColor: "hsl(var(--border))",
  secondaryColor: "hsl(var(--smui-surface-2))",
  secondaryTextColor: "hsl(var(--foreground))",
  tertiaryBorderColor: "hsl(var(--border))",
  tertiaryColor: "hsl(var(--background))",
  tertiaryTextColor: "hsl(var(--foreground))",
} as const;

export const renderMermaidDiagram: MermaidRender = async (id, source) => {
  const mermaidModule = await import("mermaid");
  const mermaid = mermaidModule.default;
  mermaid.initialize({
    deterministicIds: true,
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace",
    securityLevel: "strict",
    startOnLoad: false,
    theme: "base",
    themeVariables: MERMAID_THEME_VARIABLES,
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
