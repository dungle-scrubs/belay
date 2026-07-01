import type { ArtifactRef } from "@trevor/session";
import { AlertTriangle, FileText, Image, Monitor, ScrollText } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { artifactSrc } from "@/blob";
import { fmtBytes } from "@/derive";
import { cn } from "@/lib/utils";

export type ArtifactViewerKind = "diagnostic" | "document" | "file" | "html" | "image" | "unknown";
export type ArtifactCapability = "copyMetadata" | "download" | "openExternal";

export interface ArtifactViewerProps {
  readonly artifact: ArtifactRef;
  readonly srcOf?: (hash: string) => string;
}

export interface ArtifactViewerEntry {
  readonly capabilities: readonly ArtifactCapability[];
  readonly icon: ComponentType<{ className?: string }>;
  readonly kind: ArtifactViewerKind;
  readonly label: string;
  readonly Viewer: ComponentType<ArtifactViewerProps>;
}

function ArtifactFrame(props: { readonly children: ReactNode; readonly className?: string }) {
  const { children, className } = props;
  return (
    <div className={cn("min-h-0 flex-1 overflow-auto bg-background", className)}>{children}</div>
  );
}

function FallbackRows({ artifact }: { readonly artifact: ArtifactRef }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
      <dt className="text-muted-foreground">name</dt>
      <dd className="min-w-0 truncate text-foreground">{artifact.name ?? "untitled artifact"}</dd>
      <dt className="text-muted-foreground">kind</dt>
      <dd className="text-foreground">{artifact.kind}</dd>
      <dt className="text-muted-foreground">mime</dt>
      <dd className="min-w-0 truncate text-foreground">{artifact.mimeType}</dd>
      <dt className="text-muted-foreground">size</dt>
      <dd className="text-foreground">{fmtBytes(artifact.size) ?? "0 B"}</dd>
      <dt className="text-muted-foreground">hash</dt>
      <dd className="min-w-0 truncate font-mono text-label text-foreground">{artifact.hash}</dd>
    </dl>
  );
}

export function ImageArtifactViewer({ artifact, srcOf = artifactSrc }: ArtifactViewerProps) {
  return (
    <ArtifactFrame className="flex items-center justify-center p-4">
      <img
        src={srcOf(artifact.hash)}
        alt={artifact.name ?? "artifact image"}
        className="max-h-full max-w-full object-contain"
      />
    </ArtifactFrame>
  );
}

export function HtmlArtifactViewer({ artifact, srcOf = artifactSrc }: ArtifactViewerProps) {
  return (
    <ArtifactFrame>
      <iframe
        title={artifact.name ?? "HTML artifact"}
        src={srcOf(artifact.hash)}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        className="h-full min-h-[32rem] w-full border-0 bg-white"
      />
    </ArtifactFrame>
  );
}

export function DocumentArtifactViewer({ artifact, srcOf = artifactSrc }: ArtifactViewerProps) {
  return (
    <ArtifactFrame>
      <iframe
        title={artifact.name ?? "document artifact"}
        src={srcOf(artifact.hash)}
        className="h-full min-h-[32rem] w-full border-0 bg-background"
      />
    </ArtifactFrame>
  );
}

export function DiagnosticArtifactViewer({ artifact }: ArtifactViewerProps) {
  return (
    <ArtifactFrame className="p-4">
      <div className="mb-4 border-l-2 border-smui-purple bg-smui-purple/[0.06] px-3 py-2 text-sm text-foreground">
        Diagnostic artifact metadata. Content stays in the blob store and can be opened or
        downloaded from the toolbar.
      </div>
      <FallbackRows artifact={artifact} />
    </ArtifactFrame>
  );
}

export function UnknownArtifactViewer({ artifact }: ArtifactViewerProps) {
  return (
    <ArtifactFrame className="p-4">
      <div className="mb-4 border-l-2 border-smui-yellow bg-smui-yellow/[0.06] px-3 py-2 text-sm text-foreground">
        This artifact type does not have an inline viewer yet.
      </div>
      <FallbackRows artifact={artifact} />
    </ArtifactFrame>
  );
}

function artifactViewerKind(artifact: ArtifactRef): ArtifactViewerKind {
  const mime = artifact.mimeType.toLowerCase();
  const name = artifact.name?.toLowerCase() ?? "";
  if (artifact.kind === "image" || mime.startsWith("image/")) {
    return "image";
  }
  if (mime === "text/html" || mime === "application/xhtml+xml" || name.endsWith(".html")) {
    return "html";
  }
  if (
    mime === "application/json" ||
    mime.endsWith("+json") ||
    name.includes("diagnostic") ||
    name.includes("report")
  ) {
    return "diagnostic";
  }
  if (artifact.kind === "document" || mime === "application/pdf" || mime.startsWith("text/")) {
    return "document";
  }
  if (artifact.kind === "file") {
    return "file";
  }
  return "unknown";
}

const VIEWERS = {
  diagnostic: {
    capabilities: ["copyMetadata", "download", "openExternal"],
    icon: ScrollText,
    kind: "diagnostic",
    label: "diagnostic",
    Viewer: DiagnosticArtifactViewer,
  },
  document: {
    capabilities: ["download", "openExternal"],
    icon: FileText,
    kind: "document",
    label: "document",
    Viewer: DocumentArtifactViewer,
  },
  file: {
    capabilities: ["download", "openExternal"],
    icon: FileText,
    kind: "file",
    label: "file",
    Viewer: UnknownArtifactViewer,
  },
  html: {
    capabilities: ["download", "openExternal"],
    icon: Monitor,
    kind: "html",
    label: "HTML",
    Viewer: HtmlArtifactViewer,
  },
  image: {
    capabilities: ["download", "openExternal"],
    icon: Image,
    kind: "image",
    label: "image",
    Viewer: ImageArtifactViewer,
  },
  unknown: {
    capabilities: ["download", "openExternal"],
    icon: AlertTriangle,
    kind: "unknown",
    label: "unknown",
    Viewer: UnknownArtifactViewer,
  },
} as const satisfies Record<ArtifactViewerKind, ArtifactViewerEntry>;

export function artifactViewerFor(artifact: ArtifactRef): ArtifactViewerEntry {
  return VIEWERS[artifactViewerKind(artifact)];
}
