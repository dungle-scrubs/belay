import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Builds a fixed-width staging wrapper for transcript-width Storybook stories - the shared replacement
 * for the per-file `Frame` that only differed by its width class. `width` is a Tailwind width class
 * (e.g. "w-[40rem]" or "mx-auto w-full max-w-3xl"); the `max-w-full` guard is applied for every caller.
 */
export function storyFrame(width: string) {
  return function Frame({ children }: { children: ReactNode }) {
    return <div className={cn(width, "max-w-full")}>{children}</div>;
  };
}
