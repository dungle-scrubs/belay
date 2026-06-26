import { useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import {
  type CommandRow,
  DEFAULT_FOOTER_HINTS,
  type FooterHint,
  filterRows,
  groupRows,
  toneClass,
} from "./types";

export interface CommandModalProps {
  /** Controlled open state. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Visible modal title (also the accessible dialog title). */
  readonly title: string;
  /** Search input placeholder. */
  readonly placeholder?: string;
  /** The rows to show, already projected into the shared contract by a domain adapter. */
  readonly rows: readonly CommandRow[];
  /** Called with the chosen row's `id` when an enabled row is selected (Enter/click). */
  readonly onSelect: (id: string) => void;
  /** Controlled search value; omit to let the modal own it internally. */
  readonly search?: string;
  readonly onSearchChange?: (value: string) => void;
  /** Footer hint chips; defaults to navigate / select / close. */
  readonly footerHints?: readonly FooterHint[];
  /** While true, the list area shows a loading state instead of rows. */
  readonly loading?: boolean;
  /** An inventory/load error: shown in place of the list, distinct from "empty". */
  readonly error?: string;
  /** Text for the no-matches empty state. */
  readonly emptyLabel?: string;
}

/**
 * The shared command modal (D-089): a centered shadcn `Command` over the dialog
 * primitives, driving keyboard navigation, search, and selection for any row set. It is
 * domain-agnostic - resume (D-090) and worktree (D-091) feed it rows via their own
 * adapters and own command execution through `onSelect`. Filtering is the pure
 * `filterRows`; cmdk runs with `shouldFilter={false}` so this component owns matching and
 * cmdk owns only highlight + arrow navigation + Enter. Disabled rows stay visible but are
 * skipped by the keyboard (cmdk `disabled`), with their reason announced.
 *
 * Dimensions are stable while filtering: the list area is a fixed height, so rows drop
 * out without resizing the shell and the selected-row highlight fills the row width.
 */
export function CommandModal({
  open,
  onOpenChange,
  title,
  placeholder = "Search…",
  rows,
  onSelect,
  search,
  onSearchChange,
  footerHints = DEFAULT_FOOTER_HINTS,
  loading = false,
  error,
  emptyLabel = "No matches",
}: CommandModalProps) {
  const [internalSearch, setInternalSearch] = useState("");
  const query = search ?? internalSearch;
  const setQuery = onSearchChange ?? setInternalSearch;

  const filtered = filterRows(rows, query);
  const groups = groupRows(filtered);
  const showList = !loading && !error && filtered.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="overflow-hidden p-0 sm:max-w-xl">
        <DialogDescription className="sr-only">
          Search and select a row; arrow keys navigate, enter selects, escape closes.
        </DialogDescription>
        <Command
          shouldFilter={false}
          className="bg-popover [&_[cmdk-item]]:px-3 [&_[cmdk-item]]:py-2"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Kbd>esc</Kbd> close
            </span>
          </div>

          <CommandInput value={query} onValueChange={setQuery} placeholder={placeholder} />

          <CommandList className="h-80 max-h-80">
            {loading ? (
              <div className="flex h-full items-center justify-center py-12 text-sm text-muted-foreground">
                Loading…
              </div>
            ) : error ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 py-12 text-center text-sm">
                <span className="text-smui-red">Could not load</span>
                <span className="text-xs text-muted-foreground">{error}</span>
              </div>
            ) : (
              <>
                {!showList ? <CommandEmpty>{emptyLabel}</CommandEmpty> : null}
                {groups.map((group) => (
                  <CommandGroup key={group.heading ?? "_"} heading={group.heading ?? undefined}>
                    {group.rows.map((row) => (
                      <CommandModalRow key={row.id} row={row} onSelect={onSelect} />
                    ))}
                  </CommandGroup>
                ))}
              </>
            )}
          </CommandList>

          <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-xs text-muted-foreground">
            {footerHints.map((hint) => (
              <span key={hint.label} className="flex items-center gap-1">
                <Kbd>{hint.keys}</Kbd> {hint.label}
              </span>
            ))}
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/** One rendered row: marker, label + metadata, right-aligned status / disabled reason. */
function CommandModalRow({
  row,
  onSelect,
}: {
  readonly row: CommandRow;
  readonly onSelect: (id: string) => void;
}) {
  const disabled = row.disabledReason != null;
  return (
    <CommandItem
      value={row.id}
      keywords={row.keywords as string[] | undefined}
      disabled={disabled}
      onSelect={() => {
        if (!disabled) {
          onSelect(row.id);
        }
      }}
      title={disabled ? row.disabledReason : undefined}
      className="items-start gap-3"
    >
      <span className="mt-0.5 flex w-3 shrink-0 justify-center">
        {row.marker ??
          (row.current ? (
            <span
              role="img"
              aria-label="current"
              className="size-1.5 rounded-full bg-smui-frost-3"
            />
          ) : null)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-foreground">{row.label}</span>
        {row.metadata ? (
          <span className="truncate text-xs text-muted-foreground">{row.metadata}</span>
        ) : null}
      </span>
      {disabled ? (
        <span className="shrink-0 text-xs text-muted-foreground italic">{row.disabledReason}</span>
      ) : row.status ? (
        <span className={cn("shrink-0 text-xs tabular-nums", toneClass(row.statusTone))}>
          {row.status}
        </span>
      ) : null}
    </CommandItem>
  );
}
