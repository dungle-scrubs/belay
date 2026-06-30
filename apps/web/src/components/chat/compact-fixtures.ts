import { Wrench } from "lucide-react";
import type { CompactDisplay } from "./compact-display";

/** A `CompactDisplay` fixture (a settled bash tool row) shared by the compact-row stories + tests;
 *  `over` sets any field a case needs (status/icon/primary/secondary/hasDetail). */
export function compactDisplay(over: Partial<CompactDisplay> = {}): CompactDisplay {
  return {
    kind: "tool",
    status: "done",
    icon: Wrench,
    primary: "bash",
    secondary: "ls -la /tmp",
    hasDetail: false,
    ...over,
  };
}
