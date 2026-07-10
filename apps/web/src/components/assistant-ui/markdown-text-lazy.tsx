"use client";

import { lazy, Suspense } from "react";
import { preloadOnIdle } from "@/lib/preload-on-idle";

// markdown-text.tsx pulls in the app's SECOND markdown stack - @assistant-ui/react-markdown plus the
// whole remark/micromark pipeline (marked in src/markdown.tsx is the primary stack) - so it loads as
// its own chunk instead of riding the initial bundle (Tier 5.1). The chunk is warmed on idle right
// after startup, well before an assistant message part can mount, so the null fallback never shows
// in practice; when it somehow does, one empty frame is quieter than flashing unstyled raw text.
// Never import markdown-text.tsx statically from app code - go through this module.
const loadMarkdownText = preloadOnIdle(() => import("@/components/assistant-ui/markdown-text"));

const MarkdownTextImpl = lazy(async () => ({ default: (await loadMarkdownText()).MarkdownText }));

/**
 * Drop-in lazy `MarkdownText`: the same context-driven, prop-less contract as the real surface
 * (which stays memoized inside markdown-text.tsx), split out of the initial bundle.
 */
export function MarkdownText() {
  return (
    <Suspense fallback={null}>
      <MarkdownTextImpl />
    </Suspense>
  );
}
