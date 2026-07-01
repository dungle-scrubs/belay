import type { ArtifactRef } from "@trevor/session";
import { Copy, Download, ExternalLink, Info, PanelRightClose, RotateCcw } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { artifactSrc } from "@/blob";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ARTIFACT_PANEL_WIDTH,
  type ArtifactPanelLayout,
  clampArtifactPanelWidth,
} from "./artifact-panel-state";
import { artifactViewerFor } from "./artifact-registry";

export interface ArtifactPanelProps {
  readonly artifact: ArtifactRef | null;
  readonly layout: ArtifactPanelLayout;
  readonly width: number;
  readonly loadStatus?: "empty" | "error" | "loading" | "ready";
  readonly onClose: () => void;
  readonly onResetWidth?: () => void;
  readonly onWidthChange?: (width: number) => void;
  readonly srcOf?: (hash: string) => string;
}

function titleOf(artifact: ArtifactRef | null): string {
  return artifact?.name ?? artifact?.mimeType ?? "Artifact";
}

function copyArtifactRef(artifact: ArtifactRef): void {
  void navigator.clipboard?.writeText(JSON.stringify(artifact, null, 2));
}

export function ArtifactPanel({
  artifact,
  layout,
  width,
  loadStatus = artifact ? "ready" : "empty",
  onClose,
  onResetWidth,
  onWidthChange,
  srcOf = artifactSrc,
}: ArtifactPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const resizeStart = useRef<{ readonly startX: number; readonly startWidth: number } | null>(null);
  const liveWidthRef = useRef<number | null>(null);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const viewer = artifact ? artifactViewerFor(artifact) : null;
  const Viewer = viewer?.Viewer;
  const url = artifact ? srcOf(artifact.hash) : null;
  const Icon = viewer?.icon;
  const displayWidth = liveWidth ?? width;
  const canCopyMetadata = viewer?.capabilities.includes("copyMetadata") ?? false;
  const canDownload = viewer?.capabilities.includes("download") ?? false;
  const canOpenExternal = viewer?.capabilities.includes("openExternal") ?? false;
  const selectedArtifactKey = artifact?.hash ?? "empty";

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onWidthChange) {
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    resizeStart.current = { startX: event.clientX, startWidth: displayWidth };
  };
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current;
    if (!start) {
      return;
    }
    const nextWidth = clampArtifactPanelWidth(start.startWidth + start.startX - event.clientX);
    liveWidthRef.current = nextWidth;
    setLiveWidth(nextWidth);
  };
  const endResize = () => {
    if (liveWidthRef.current !== null) {
      onWidthChange?.(liveWidthRef.current);
    }
    liveWidthRef.current = null;
    setLiveWidth(null);
    resizeStart.current = null;
  };
  const onResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!onWidthChange) {
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onWidthChange(clampArtifactPanelWidth(displayWidth + 24));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onWidthChange(clampArtifactPanelWidth(displayWidth - 24));
    } else if (event.key === "Home") {
      event.preventDefault();
      onWidthChange(ARTIFACT_PANEL_WIDTH.min);
    } else if (event.key === "End") {
      event.preventDefault();
      onWidthChange(ARTIFACT_PANEL_WIDTH.max);
    }
  };

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: selectedArtifactKey === "empty" });
    // Focus should move when selection changes, even if the shell stays mounted.
  }, [selectedArtifactKey]);

  return (
    <aside
      ref={panelRef}
      aria-label="artifact workspace"
      data-artifact-panel
      data-artifact-layout={layout}
      data-artifact-status={loadStatus}
      tabIndex={-1}
      className={cn(
        "relative flex h-full min-w-0 shrink-0 flex-col border-border border-l bg-card/70 shadow-sm",
        layout === "overlap" && "absolute top-0 right-0 bottom-0 z-30",
        layout === "replace" && "w-full",
      )}
      style={layout === "replace" ? undefined : { width: displayWidth }}
    >
      {layout !== "replace" ? (
        <div
          role="slider"
          aria-label="Resize artifact panel"
          aria-valuemax={ARTIFACT_PANEL_WIDTH.max}
          aria-valuemin={ARTIFACT_PANEL_WIDTH.min}
          aria-valuenow={Math.round(displayWidth)}
          tabIndex={0}
          onPointerDown={startResize}
          onPointerMove={resize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onKeyDown={onResizeKeyDown}
          className="absolute top-0 bottom-0 left-0 z-10 w-2 -translate-x-1 cursor-col-resize touch-none"
        >
          <span className="mx-auto block h-full w-px bg-border" />
        </div>
      ) : null}

      <header className="flex min-h-12 shrink-0 items-center gap-2 border-border border-b px-3">
        {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : null}
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-medium text-sm text-foreground">{titleOf(artifact)}</h2>
          <p className="truncate text-label tracking-wider text-muted-foreground">
            {viewer?.label ?? "no artifact"} {artifact ? `· ${artifact.mimeType}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {artifact ? (
            <>
              {canCopyMetadata ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Copy artifact metadata"
                  title="Copy artifact metadata"
                  onClick={() => copyArtifactRef(artifact)}
                >
                  <Copy className="size-3.5" />
                </Button>
              ) : null}
              {url && (canOpenExternal || canDownload) ? (
                <>
                  {canOpenExternal ? (
                    <Button
                      asChild
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Open artifact externally"
                      title="Open artifact externally"
                    >
                      <a href={url} target="_blank" rel="noreferrer">
                        <ExternalLink className="size-3.5" />
                      </a>
                    </Button>
                  ) : null}
                  {canDownload ? (
                    <Button
                      asChild
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Download artifact"
                      title="Download artifact"
                    >
                      <a href={url} download={artifact.name ?? artifact.hash}>
                        <Download className="size-3.5" />
                      </a>
                    </Button>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
          {onResetWidth ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Reset artifact panel width"
              title="Reset artifact panel width"
              onClick={onResetWidth}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Close artifact panel"
            title="Close artifact panel"
            onClick={onClose}
          >
            <PanelRightClose className="size-3.5" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {loadStatus === "loading" ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            loading artifact...
          </div>
        ) : loadStatus === "error" ? (
          <div className="m-4 flex items-start gap-2 border border-smui-red/25 bg-smui-red/[0.05] p-3 text-sm text-foreground">
            <Info className="mt-0.5 size-4 shrink-0 text-smui-red" />
            The artifact could not be loaded. Use open or download from the toolbar.
          </div>
        ) : artifact && Viewer ? (
          <Viewer artifact={artifact} srcOf={srcOf} />
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
            Select an artifact from the transcript to open it here.
          </div>
        )}
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-2 border-border border-t px-3 py-2 text-label tracking-wider text-muted-foreground">
        <span>{layout} layout</span>
        <span>
          {Math.round(displayWidth)}px · {ARTIFACT_PANEL_WIDTH.min}-{ARTIFACT_PANEL_WIDTH.max}px
        </span>
      </footer>
    </aside>
  );
}
