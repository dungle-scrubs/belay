import { useMemo } from "react";
import { CommandModal } from "./CommandModal";
import type { CommandRow, FooterHint } from "./types";

/**
 * A domain adapter for {@link RowChooserModal}: the fixed chrome of one chooser (its title,
 * placeholder, empty-state text, and footer hints) plus the pure projection from that domain's data +
 * context into the shared {@link CommandRow} contract. One adapter per chooser surface (resume,
 * worktrees) - a new chooser is an adapter, not another modal wrapper.
 */
export interface RowChooserAdapter<TData, TContext> {
  readonly title: string;
  readonly placeholder: string;
  readonly emptyLabel: string;
  readonly footerHints: readonly FooterHint[];
  readonly buildRows: (data: TData, context: TContext) => readonly CommandRow[];
}

export interface RowChooserModalProps<TData, TContext> {
  readonly adapter: RowChooserAdapter<TData, TContext>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly data: TData;
  readonly context: TContext;
  readonly loading?: boolean;
  readonly error?: string | null;
  /** Called with the chosen row's id (an enabled row only); the modal then closes. */
  readonly onSelect: (id: string) => void;
}

/**
 * The shared body every domain chooser repeated: memoize the adapter's rows over its data + context,
 * feed them and the adapter's chrome to {@link CommandModal}, and close on a selection after invoking
 * `onSelect`. The per-domain wrappers (resume D-090, worktrees D-091) are now a one-line binding of
 * their adapter + data to this, so the useMemo/CommandModal/close-on-select structure lives once.
 */
export function RowChooserModal<TData, TContext>({
  adapter,
  open,
  onOpenChange,
  data,
  context,
  loading,
  error,
  onSelect,
}: RowChooserModalProps<TData, TContext>) {
  const rows = useMemo(() => adapter.buildRows(data, context), [adapter, data, context]);
  return (
    <CommandModal
      open={open}
      onOpenChange={onOpenChange}
      title={adapter.title}
      placeholder={adapter.placeholder}
      rows={rows}
      loading={loading}
      error={error ?? undefined}
      emptyLabel={adapter.emptyLabel}
      footerHints={adapter.footerHints}
      onSelect={(id) => {
        onSelect(id);
        onOpenChange(false);
      }}
    />
  );
}
