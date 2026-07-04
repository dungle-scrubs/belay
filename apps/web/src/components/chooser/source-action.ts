import type { SourceAction } from "@trevor/session";

/**
 * Maps a host-owned {@link SourceAction} to the ONE App-level effect it triggers (53 D-003). The
 * chooser renders whatever actions the host announces and forwards them to the App; this is the single
 * place that decides what each action DOES, so no action can silently no-op the way `configure` used to
 * (the App handler had no `configure` branch, so the "Configure" button did nothing on any machine).
 *
 * The mapping is exhaustive over the whole `SourceAction` union (a compile-time `assertNever` guard), so
 * adding a future action forces a decision here instead of being dropped. `authenticate` and
 * `reauthenticate` share the sign-in effect; `configure` surfaces the host auth-store setup guidance
 * (the source's `SourceAuthPanel` copy) - never a key-paste form.
 */
export type SourceActionCommand =
  /** Re-query each configured source's live `/models` (the shared catalog refresh). */
  | { readonly kind: "refresh-catalog" }
  /** Run the host-owned OAuth device-code / browser+paste sign-in for this source. */
  | { readonly kind: "sign-in" }
  /** Surface the host auth-store setup guidance for this source (no host round-trip, no key field):
   *  the Claude subscription shows the `claude setup-token` copy, the Anthropic Direct API and the
   *  other api-key sources show the `~/.pi/auth.json` key copy. */
  | { readonly kind: "show-setup-guidance" }
  /** Disable/hide the source. No source offers this today; kept so the mapping stays exhaustive. */
  | { readonly kind: "disable" };

/** Exhaustiveness guard: a compile error here means a new `SourceAction` has no mapped command. */
function assertNever(value: never): never {
  throw new Error(`unhandled source action: ${String(value)}`);
}

/** Resolves the App-level command for a source action. Pure, so the dispatch is unit-tested. */
export function sourceActionCommand(action: SourceAction): SourceActionCommand {
  switch (action) {
    case "refresh":
      return { kind: "refresh-catalog" };
    case "authenticate":
    case "reauthenticate":
      return { kind: "sign-in" };
    case "configure":
      return { kind: "show-setup-guidance" };
    case "disable":
      return { kind: "disable" };
    default:
      return assertNever(action);
  }
}
