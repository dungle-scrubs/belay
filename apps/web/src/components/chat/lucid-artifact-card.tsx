import type { ArtifactRef } from "@trevor/session";
import { PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The transcript card for a published LUCID artifact (plan 27, M2/M7): a compact, native Trevor row
 * that OPENS the addressable artifact in the right-side panel - never a separate `lucid open` browser
 * tab. The transcript stays readable (one quiet card); the review surface lives in the panel.
 */
export function LucidArtifactCard(props: {
  readonly title: string;
  readonly version: number;
  readonly artifact: ArtifactRef;
  readonly onOpenArtifact?: (artifact: ArtifactRef) => void;
}) {
  const { title, version, artifact, onOpenArtifact } = props;
  return (
    <div className="flex items-center gap-3 border border-border bg-card/60 px-3 py-2">
      <PenLine className="size-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-foreground text-sm">{title}</p>
        <p className="text-label tracking-wider text-muted-foreground">
          Lucid artifact · v{version} · review in the panel
        </p>
      </div>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={!onOpenArtifact}
        onClick={() => onOpenArtifact?.(artifact)}
      >
        open
      </Button>
    </div>
  );
}
