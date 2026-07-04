import { useKeyPress } from "ahooks";
import type { Pencil } from "lucide-react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * A right-click context menu for a row (extracted from the session sidebar, D-094, so the model chooser
 * reuses the exact same template - plan 51 D-002). Styled with the shadcn popover tokens but with NO
 * extra radix dependency: a portal'd menu positioned at the cursor over a transparent full-screen layer
 * that dismisses it on an outside click/right-click; Escape dismisses it too. The row's own controls
 * (its nested buttons) keep working - the menu is a progressive right-click enhancement over the wrapper.
 */

export interface RowMenuItem {
  readonly label: string;
  readonly icon: typeof Pencil;
  readonly onSelect: () => void;
  readonly danger?: boolean;
}

export function RowContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: readonly RowMenuItem[];
  onClose: () => void;
}) {
  useKeyPress("Escape", onClose);

  return createPortal(
    <button
      type="button"
      aria-label="Close menu"
      className="fixed inset-0 z-50 cursor-default"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled at the window level above. */}
      <div
        role="menu"
        style={{ position: "absolute", top: y, left: x }}
        className="min-w-40 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                item.onSelect();
                onClose();
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
                item.danger
                  ? "text-destructive hover:bg-destructive/10"
                  : "hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              {item.label}
            </button>
          );
        })}
      </div>
    </button>,
    document.body,
  );
}
