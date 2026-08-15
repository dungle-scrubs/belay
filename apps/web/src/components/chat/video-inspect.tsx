import type { ArtifactRef } from "@belay/session";
import { Film, TriangleAlert } from "lucide-react";
import { toolActionLabelForTarget } from "@/action-label";
import { MessageImages } from "./message-images";
import { StatusAwareToolRenderer } from "./status-aware-tool-renderer";
import type { ToolStatus } from "./tool-status";

/**
 * Responsible for: the video_inspect transcript result - a concise row showing the sampled-frame
 * thumbnails plus metadata (duration, dimensions, sampled count, truncation) and any warnings, and
 * the structured parse of the tool's JSON result. Missing binaries render as a quiet unavailable
 * note, never a broken row. The frame thumbnails reuse the shared MessageImages tiles (plan 34).
 *
 * Not for: the deeper per-frame timeline (that is the tool-detail takeover), the host extraction
 * (apps/agent-host video-inspect), or provider continuation.
 */

export interface VideoInspectFrame {
  readonly frameIndex: number;
  readonly timestampMs: number;
  readonly width?: number;
  readonly height?: number;
  readonly artifact?: ArtifactRef;
}

export interface ParsedVideoInspect {
  readonly unavailable?: boolean;
  readonly path?: string;
  readonly durationMs?: number;
  readonly width?: number;
  readonly height?: number;
  readonly sampledFrameCount?: number;
  readonly truncated?: boolean;
  readonly warnings?: readonly string[];
  readonly missingBinaries?: readonly string[];
  readonly frames?: readonly VideoInspectFrame[];
  readonly error?: string;
}

/** Parses the video_inspect JSON result defensively: null while running, `{error}` for the
 *  `error:` convention or a non-video body, else the structured shape. */
export function parseVideoInspectResult(raw: string | undefined): ParsedVideoInspect | null {
  if (!raw) {
    return null;
  }
  if (raw.startsWith("error:")) {
    return { error: raw.replace(/^error:\s*/u, "") };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.processor === "video") {
      return {
        unavailable: parsed.unavailable === true,
        path: str(parsed.path),
        durationMs: num(parsed.durationMs),
        width: num(parsed.width),
        height: num(parsed.height),
        sampledFrameCount: num(parsed.sampledFrameCount),
        truncated: parsed.truncated === true,
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter(isString) : undefined,
        missingBinaries: Array.isArray(parsed.missingBinaries)
          ? parsed.missingBinaries.filter(isString)
          : undefined,
        frames: Array.isArray(parsed.frames) ? parsed.frames.map(toFrame) : undefined,
      };
    }
  } catch {
    // Truncated or non-JSON; fall through to a generic error display below.
  }
  return { error: raw };
}

/** The frame images as ArtifactRefs, each captioned with its sampling timestamp for the tile tooltip. */
export function videoFrameArtifacts(frames: readonly VideoInspectFrame[]): ArtifactRef[] {
  return frames
    .filter((frame): frame is VideoInspectFrame & { artifact: ArtifactRef } =>
      Boolean(frame.artifact),
    )
    .map((frame) => ({ ...frame.artifact, name: formatFrameTimestamp(frame.timestampMs) }));
}

interface VideoInspectResultProps {
  readonly args: string;
  readonly parsed?: ParsedVideoInspect | null;
  readonly status?: ToolStatus;
  readonly className?: string;
  /** Resolves a frame hash to an image URL; defaults (via MessageImages) to the blob-store src. */
  readonly srcOf?: (hash: string) => string;
  readonly onOpenArtifact?: (artifact: ArtifactRef) => void;
  /** Ms epoch of the tool's start; feeds the running row's live elapsed clock (58.6.1 M2). */
  readonly startedAt?: number;
}

export function VideoInspectResult({
  args,
  parsed,
  status = "done",
  className,
  srcOf,
  onOpenArtifact,
  startedAt,
}: VideoInspectResultProps) {
  return (
    <StatusAwareToolRenderer
      name="video_inspect"
      args={args}
      status={status}
      error={parsed?.error}
      running={status === "running" && !parsed}
      runningLabel={toolActionLabelForTarget("video_inspect", args)}
      startedAt={startedAt}
      className={className}
      renderBody={() =>
        parsed ? (
          <VideoInspectBody parsed={parsed} srcOf={srcOf} onOpenArtifact={onOpenArtifact} />
        ) : null
      }
    />
  );
}

export function VideoInspectBody({
  parsed,
  srcOf,
  onOpenArtifact,
}: {
  readonly parsed: ParsedVideoInspect;
  readonly srcOf?: (hash: string) => string;
  readonly onOpenArtifact?: (artifact: ArtifactRef) => void;
}) {
  const frames = parsed.frames ?? [];
  const warnings = parsed.warnings ?? [];
  const images = videoFrameArtifacts(frames);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Film className="size-3.5 shrink-0 text-smui-frost-3" />
          {parsed.unavailable
            ? "unavailable"
            : `${parsed.sampledFrameCount ?? frames.length} frames`}
        </span>
        {parsed.durationMs !== undefined ? <span>{formatDuration(parsed.durationMs)}</span> : null}
        {parsed.width !== undefined && parsed.height !== undefined ? (
          <span>
            {parsed.width}×{parsed.height}
          </span>
        ) : null}
        {parsed.truncated ? <span className="text-smui-yellow">truncated</span> : null}
      </div>
      {parsed.unavailable && parsed.missingBinaries?.length ? (
        <span className="text-xs text-muted-foreground">
          missing {parsed.missingBinaries.join(", ")}
        </span>
      ) : null}
      {warnings.length ? (
        <div className="flex flex-col gap-1 text-xs text-smui-yellow">
          {warnings.map((warning) => (
            <span key={warning} className="inline-flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              {warning}
            </span>
          ))}
        </div>
      ) : null}
      {images.length ? (
        <MessageImages
          images={images}
          others={[]}
          {...(srcOf ? { srcOf } : {})}
          {...(onOpenArtifact ? { onOpenArtifact } : {})}
        />
      ) : null}
    </div>
  );
}

/** "3.0s" under a minute, else "1m 03s". */
export function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

/** A frame's sampling offset as a compact caption, e.g. "0.0s" / "1.5s". */
export function formatFrameTimestamp(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function toFrame(value: unknown): VideoInspectFrame {
  const record = (value ?? {}) as Record<string, unknown>;
  const artifact = record.artifact;
  return {
    frameIndex: num(record.frameIndex) ?? 0,
    timestampMs: num(record.timestampMs) ?? 0,
    width: num(record.width),
    height: num(record.height),
    ...(isImageArtifact(artifact) ? { artifact } : {}),
  };
}

function isImageArtifact(value: unknown): value is ArtifactRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).hash === "string" &&
    typeof (value as Record<string, unknown>).mimeType === "string"
  );
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
