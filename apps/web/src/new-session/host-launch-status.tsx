import { Loader2 } from "lucide-react";

/**
 * The no-host badge's recovery affordances (plan 44.3), rendered as the side-panel header `statusNode`
 * when the viewed session has no live host. This is the PRESENTATIONAL surface (Storybook-first), pure
 * over an injected discriminated state; the launch wiring (root resolution + the shared `useLaunch`
 * machine) lives in `app.tsx`. The host-active / host-starting branches stay in `app.tsx`; this owns only
 * the four no-host sub-states.
 *
 * `startable` and `failed` carry a single deterministic action (Start host / Retry) so a no-host session
 * is never a dead end; `starting` is one phase whose label reads "restarting host…" for a stale host
 * that was here before and "starting host…" for a fresh one; `hint` keeps the pre-44.3 shell-command
 * hint for a session whose root cannot be resolved (nowhere to launch).
 */
export type HostLaunchState =
  | {
      readonly phase: "startable";
      readonly onStart: () => void;
      /** A prior attempt's give-up reason (e.g. a host.online timeout) surfaced beside Start, so a
       *  silently-dropped launch is explained; absent when there is no lingering error. */
      readonly error?: string | null;
    }
  | { readonly phase: "starting"; readonly restarting: boolean }
  | { readonly phase: "failed"; readonly error: string; readonly onRetry: () => void }
  | { readonly phase: "hint"; readonly command: string };

/** A compact inline button matching the panel header's other chip buttons; the pointer cursor comes from
 *  the `index.css` base layer, so none is added here. */
const chipButtonClass =
  "shrink-0 rounded border border-border bg-background px-2 py-0.5 text-label tracking-wider text-foreground hover:bg-secondary";

export function HostLaunchStatus({ state }: { readonly state: HostLaunchState }) {
  if (state.phase === "starting") {
    return (
      <span role="status" className="inline-flex items-center gap-1.5 text-smui-yellow">
        <Loader2 className="size-3 animate-spin" />
        {state.restarting ? "restarting host…" : "starting host…"}
      </span>
    );
  }

  if (state.phase === "failed") {
    return (
      <span className="inline-flex min-w-0 items-center gap-2 text-smui-red">
        <span role="alert" className="min-w-0 truncate">
          ● start failed - {state.error}
        </span>
        <button type="button" onClick={() => state.onRetry()} className={chipButtonClass}>
          Retry
        </button>
      </span>
    );
  }

  if (state.phase === "startable") {
    return (
      <span className="inline-flex items-center gap-2 text-smui-yellow">
        {state.error ? (
          <span role="alert" className="text-smui-red">
            ● {state.error}
          </span>
        ) : (
          "● no host"
        )}
        <button type="button" onClick={() => state.onStart()} className={chipButtonClass}>
          Start host
        </button>
      </span>
    );
  }

  // hint: no resolvable root - keep the plain shell-command hint (the pre-44.3 dead-end behavior, now
  // reached only when neither the log, the inventory, nor projects.json knows the session's root).
  return (
    <span className="text-smui-yellow">
      ● no host - <code className="text-foreground">{state.command}</code>
    </span>
  );
}
