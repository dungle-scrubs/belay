"use client";

import { lazy, Suspense } from "react";
import type { DiffViewerProps } from "@/components/assistant-ui/diff-viewer";
import { preloadOnIdle } from "@/lib/preload-on-idle";

// diff-viewer.tsx carries the diff parsing/printing vendors (`diff`, `parse-diff`), which only tool
// rows with write/edit output ever need, so it loads as its own chunk instead of riding the initial
// bundle (Tier 5.2). The chunk is warmed on idle right after startup, so by the time a transcript
// renders a diff the real viewer is virtually always resolved. Never import diff-viewer.tsx
// statically from app code - go through this module (stories may import it directly).
const loadDiffViewer = preloadOnIdle(() => import("@/components/assistant-ui/diff-viewer"));

const DiffViewerImpl = lazy(async () => ({ default: (await loadDiffViewer()).DiffViewer }));

// A quiet stand-in for the beat before the chunk resolves: a low-contrast bar roughly one diff line
// tall, so the tool row doesn't collapse to nothing and then jump.
function DiffViewerLoading() {
  return (
    <div data-slot="diff-viewer-loading" aria-hidden="true" className="bg-muted/30 h-6 rounded-lg" />
  );
}

/** Drop-in lazy `DiffViewer`: same props as the real viewer, split out of the initial bundle. */
export function DiffViewer(props: DiffViewerProps) {
  return (
    <Suspense fallback={<DiffViewerLoading />}>
      <DiffViewerImpl {...props} />
    </Suspense>
  );
}
