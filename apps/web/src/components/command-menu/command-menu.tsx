import { type CommandMenuPayload, type CommandMenuRow, isSubmenu } from "@trevor/session";
import { ArrowLeft, Check, ChevronRight, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCommandMenu } from "./use-command-menu";

/**
 * The generic nested command-menu renderer (plan 03, M2). It draws ANY host-owned
 * {@link CommandMenuPayload} - the row labels, disabled reasons, badges, and submenu structure all come
 * from data, so there is no command-specific branch in here (the `/style` first consumer and any future
 * family share it). It reuses the model-chooser's transcript-takeover shape: a header with a back arrow +
 * title/breadcrumb, an optional search box, and a keyboard-navigable row list with disabled/selected/badge
 * states and an empty state.
 */

export interface CommandMenuProps {
  readonly payload: CommandMenuPayload;
  /** Dispatch a chosen leaf action back through the command path (e.g. `/style concise`). */
  readonly onAction: (family: string, actionId: string) => void;
  /** Invoked when the user backs out at the root level (close the takeover). */
  readonly onClose?: () => void;
  /** Open this submenu initially (deep-link / Storybook); defaults to the root level. */
  readonly defaultOpenId?: string;
  readonly className?: string;
}

export function CommandMenu({
  payload,
  onAction,
  onClose,
  defaultOpenId,
  className,
}: CommandMenuProps) {
  const menu = useCommandMenu(payload, { onAction, onClose, defaultOpenId });
  return (
    <section
      aria-label={`${payload.title} menu`}
      tabIndex={-1}
      onKeyDown={(event) => menu.onKeyDown(event)}
      className={cn("@container flex min-h-0 flex-col bg-background text-foreground", className)}
    >
      <header className="flex flex-col gap-3 border-b border-border p-4">
        <div className="flex items-center gap-2">
          {menu.canGoBack ? (
            <Button variant="ghost" size="icon-sm" onClick={menu.back} aria-label="Back">
              <ArrowLeft />
            </Button>
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-base font-medium">{menu.title}</span>
            {menu.breadcrumb.length > 1 ? (
              <nav aria-label="Breadcrumb" className="truncate text-xs text-muted-foreground">
                {menu.breadcrumb.join(" / ")}
              </nav>
            ) : null}
          </div>
        </div>
        {menu.searchable ? (
          <div className="flex h-9 items-center gap-2 rounded-md border border-input bg-transparent px-2.5">
            <Search className="size-4 shrink-0 opacity-50" />
            <input
              value={menu.query}
              onChange={(event) => menu.setQuery(event.target.value)}
              placeholder={`Search ${payload.title}`}
              aria-label={`Search ${payload.title}`}
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        ) : null}
      </header>

      {menu.rows.length === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">{menu.emptyText}</p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
          {menu.rows.map((row, index) => (
            <CommandMenuRowView
              key={row.id}
              row={row}
              highlighted={index === menu.highlighted}
              onActivate={() => menu.activate(row)}
              onHover={() => menu.setHighlighted(index)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CommandMenuRowView({
  row,
  highlighted,
  onActivate,
  onHover,
}: {
  readonly row: CommandMenuRow;
  readonly highlighted: boolean;
  readonly onActivate: () => void;
  readonly onHover: () => void;
}) {
  const disabled = Boolean(row.disabledReason);
  const detail = row.disabledReason ?? row.description;
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        aria-disabled={disabled}
        aria-current={row.selected ? "true" : undefined}
        data-highlighted={highlighted ? "" : undefined}
        onClick={onActivate}
        onMouseMove={onHover}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm",
          highlighted && !disabled && "bg-accent text-accent-foreground",
          disabled ? "opacity-50" : "hover:bg-accent/50",
        )}
      >
        {row.selected ? (
          <Check className="size-4 shrink-0 text-primary" aria-hidden />
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{row.label}</span>
          {detail ? <span className="truncate text-xs text-muted-foreground">{detail}</span> : null}
        </span>
        {row.badge ? <Badge variant="secondary">{row.badge}</Badge> : null}
        {isSubmenu(row) ? (
          <ChevronRight className="size-4 shrink-0 opacity-50" aria-hidden />
        ) : null}
      </button>
    </li>
  );
}
