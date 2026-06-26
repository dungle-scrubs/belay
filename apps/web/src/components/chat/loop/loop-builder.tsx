import { Check, CircleDot, TriangleAlert } from "lucide-react";
import type { CommandPresentation } from "@/commands/command-family";
import { cn } from "@/lib/utils";

/**
 * The live `/loop` builder: a structured read-out of what the typed command will
 * create. Each field is a row (set value, or a flagged gap with the hint that
 * fills it); value errors list below; a ready indicator shows when Enter will
 * create a valid loop.
 *
 * Pure render: it consumes the precomputed command presentation view-model (rows +
 * filtered errors + ready), not the raw parse result. There is no Confirm button:
 * submitting the composer (Enter) is the confirmation.
 */
export function LoopBuilder(props: { view: CommandPresentation; className?: string }) {
  const { view, className } = props;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <dl className="flex flex-col gap-1">
        {view.rows.map((row) => (
          <div key={row.field} className="flex items-baseline gap-3 text-ui">
            <dt className="w-20 shrink-0 text-label tracking-wider text-muted-foreground uppercase">
              {row.label}
            </dt>
            <dd className="min-w-0 flex-1">
              {row.missing ? (
                <span className="inline-flex items-center gap-1.5 text-smui-yellow">
                  <TriangleAlert className="size-3.5 shrink-0" />
                  {row.hint}
                </span>
              ) : (
                <span className="break-words text-foreground">{row.value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>

      {view.errors.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {view.errors.map((diagnostic) => (
            <li
              key={diagnostic.code + diagnostic.message}
              className="flex items-baseline gap-1.5 text-ui text-smui-red"
            >
              <TriangleAlert className="size-3.5 shrink-0 translate-y-0.5" />
              {diagnostic.message}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="border-t border-border pt-2">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 text-label tracking-wider uppercase",
            view.ready ? "text-smui-green" : "text-muted-foreground",
          )}
        >
          {view.ready ? (
            <Check className="size-3.5 shrink-0" />
          ) : (
            <CircleDot className="size-3.5 shrink-0" />
          )}
          {view.ready ? "ready" : "incomplete"}
        </span>
      </div>
    </div>
  );
}
