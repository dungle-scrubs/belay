import type { ElementType, ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/** The semantic tones a transcript alert can carry (the smui accent colors). */
export type AlertTone = "yellow" | "blue" | "purple";

// One literal class string per tone (Tailwind can't see dynamically-built class names), so a tone is
// a single token instead of the three hand-matched `border-/bg-/[&>svg]:text-` strings that were
// repeated per alert and could drift into a fifth subtly-different yellow.
const TONE_BOX: Record<AlertTone, string> = {
  yellow: "border-smui-yellow/25 bg-smui-yellow/[0.04] [&>svg]:text-smui-yellow",
  blue: "border-smui-blue/25 bg-smui-blue/[0.04] [&>svg]:text-smui-blue",
  purple: "border-smui-purple/25 bg-smui-purple/[0.04] [&>svg]:text-smui-purple",
};
const TONE_TEXT: Record<AlertTone, string> = {
  yellow: "text-smui-yellow",
  blue: "text-smui-blue",
  purple: "text-smui-purple",
};

/**
 * A tone-coded transcript alert: the box border/background/icon and the title color all driven by one
 * `tone` token. `titleClassName` overrides the title color when a status (e.g. delegation running vs
 * failed) differs from the box tone; `descriptionClassName` tweaks the body. Restyling a tone is one
 * map entry here, not a class string copied across every row that uses it.
 */
export function ToneAlert({
  tone,
  icon: Icon,
  title,
  titleClassName,
  descriptionClassName,
  children,
}: {
  readonly tone: AlertTone;
  readonly icon: ElementType;
  readonly title: ReactNode;
  readonly titleClassName?: string;
  readonly descriptionClassName?: string;
  readonly children: ReactNode;
}) {
  return (
    <Alert className={TONE_BOX[tone]}>
      <Icon className="h-3.5 w-3.5" />
      <AlertTitle className={titleClassName ?? TONE_TEXT[tone]}>{title}</AlertTitle>
      <AlertDescription className={descriptionClassName}>{children}</AlertDescription>
    </Alert>
  );
}
