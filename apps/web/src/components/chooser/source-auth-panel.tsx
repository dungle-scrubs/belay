import type { SourceAction, SourceSummary } from "@trevor/session";
import {
  ExternalLink,
  KeyRound,
  LogIn,
  RefreshCw,
  ShieldAlert,
  TerminalSquare,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The source auth / setup panel (D-065 M5): the no-secret authentication boundary inside a source's
 * detail view. It renders the host-owned auth STATE and the action to fix it - sign in / re-login for
 * OAuth, a device/provider-code flow (a link + a short NON-key code) where the protocol needs one,
 * "configure in the host auth store" for direct API keys, and "start the runtime" guidance for a local
 * source - but it NEVER renders an API-key paste form. Direct keys, env-derived credentials, and
 * provider secrets live in the host auth JSON store (`~/.pi/auth.json`); the browser only ever
 * sees state and triggers host flows.
 *
 * Scoped to one source: an auth failure here never blocks browsing or selecting other configured
 * sources. Presentational over the host read models; the actions are callbacks the App wires to the
 * host's auth/catalog flows.
 */

/** Where the host stores credentials - shown to the user as guidance, never an editable field. */
const HOST_AUTH_STORE = "~/.pi/auth.json";

/** An in-progress device / provider-code flow the host started (a link + a short code to authorize). */
export interface DeviceCodeFlow {
  /** The URL the user opens to authorize (host-provided). */
  readonly verificationUrl: string;
  /** The short user code to enter at that URL - a device code, NOT an API key. Absent for a
   *  browser+paste flow (the code is returned at the URL and pasted back). */
  readonly userCode?: string;
  /**
   * Whether this provider's protocol needs the user to paste a code BACK into Trevor (a non-key
   * provider code). When true, a small code input is shown; it is never used for an API key.
   */
  readonly acceptsCode?: boolean;
}

export interface SourceAuthPanelProps {
  readonly source: SourceSummary;
  /** A device/provider-code flow to display, when the host has started one for this source. */
  readonly deviceCode?: DeviceCodeFlow | null;
  /** Trigger a host-owned auth/setup/refresh action (sign-in, re-auth, configure, refresh). */
  readonly onAction: (action: SourceAction) => void;
  /** Submit a non-key provider code (device/provider-code flows only). */
  readonly onSubmitCode?: (code: string) => void;
  readonly className?: string;
}

/**
 * The label + icon for every `SourceAction`, shared by the auth panel's buttons and the model
 * chooser's action chips so the two can't drift on what a source action is called (they previously
 * disagreed - "Refresh catalog" vs "Refresh"). `SourceAction` ships no projection, so this presentation
 * map lives here; it carries lucide icons, which keep it web-side rather than in the session contract.
 */
export const SOURCE_ACTION_META: Record<SourceAction, { label: string; icon: typeof LogIn }> = {
  authenticate: { label: "Sign in", icon: LogIn },
  reauthenticate: { label: "Re-authenticate", icon: LogIn },
  refresh: { label: "Refresh catalog", icon: RefreshCw },
  configure: { label: "Configure", icon: KeyRound },
  disable: { label: "Disable", icon: ShieldAlert },
};

/** Whether a source needs the auth panel shown at all (it's authenticated + ready otherwise). */
export function needsAuthPanel(source: SourceSummary, deviceCode?: DeviceCodeFlow | null): boolean {
  if (deviceCode) {
    return true;
  }
  return (
    source.status === "needs-auth" ||
    source.status === "error" ||
    source.auth === "none" ||
    source.auth === "expired" ||
    (source.type === "local" && source.status === "unavailable")
  );
}

/** The headline + body copy for a source's auth/setup state (pure, so the wording is unit-tested). */
export function authCopy(source: SourceSummary): { title: string; body: string } {
  if (source.type === "local") {
    return {
      title: "Start the local runtime",
      body: "Trevor connects to a local runtime you run yourself - it does not install or manage it. Start the runtime, then refresh to load its models.",
    };
  }
  if (source.type === "oauth") {
    // Every oauth source (the Claude subscription, OpenAI/Codex) has an in-app sign-in: its action
    // projects to `authenticate`, so the panel shows the "Sign in to {label}" copy and a real Sign in
    // button that runs the host-owned browser OAuth flow (53.1 D-001). No oauth source carries the old
    // setup-token `configure` special-case anymore. `configure` now means api-key/gateway/local only.
    return source.auth === "expired"
      ? {
          title: "Your sign-in expired",
          body: "Re-authenticate through the provider to keep using this subscription. Trevor opens the provider's sign-in; no credentials are entered here.",
        }
      : {
          title: `Sign in to ${source.label}`,
          body: "Authorize this subscription through the provider's sign-in. Trevor opens the host-owned flow; no password or key is entered in this chooser.",
        };
  }
  // Direct API key / gateway: keys live in the host auth store, never pasted here.
  if (source.status === "error") {
    return {
      title: "The configured key was rejected",
      body: `The key for this source was rejected by the provider. Update it in the host auth store (${HOST_AUTH_STORE}); Trevor never accepts a key typed into the chooser.`,
    };
  }
  return {
    title: "No API key configured",
    body: `Add this provider's key to the host auth store (${HOST_AUTH_STORE}). Direct keys and env-derived secrets live there, never in the browser - this chooser has no key field by design.`,
  };
}

export function SourceAuthPanel({
  source,
  deviceCode,
  onAction,
  onSubmitCode,
  className,
}: SourceAuthPanelProps) {
  const [code, setCode] = useState("");
  const action = source.actions[0] ?? null;
  const ActionIcon = action ? SOURCE_ACTION_META[action].icon : null;
  const copy = authCopy(source);
  const Icon =
    source.type === "local" ? TerminalSquare : source.type === "oauth" ? LogIn : KeyRound;

  return (
    <section
      aria-label="Source authentication"
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-sm font-medium">{copy.title}</h3>
          <p className="text-xs text-muted-foreground">{copy.body}</p>
        </div>
      </div>

      {deviceCode ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
          <p className="text-xs text-muted-foreground">
            {deviceCode.userCode
              ? "Open the authorization page and enter this code:"
              : deviceCode.acceptsCode
                ? "Open the authorization page, then paste the code it gives you below:"
                : "Open the authorization page to continue:"}
          </p>
          {/* A device/OAuth verification URL can be very long (query params + tokens), so it must WRAP
              inside the panel instead of pushing past its edge (53 D-004). The row wraps, the anchor
              can shrink (min-w-0) and its URL text breaks between characters (break-all), while the
              external-link icon and the short code chip stay whole (shrink-0). */}
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={deviceCode.verificationUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
            >
              <span className="break-all">{deviceCode.verificationUrl}</span>
              <ExternalLink className="size-3.5 shrink-0" />
            </a>
            {deviceCode.userCode ? (
              <code className="shrink-0 rounded bg-muted px-2 py-0.5 font-mono text-sm tracking-widest">
                {deviceCode.userCode}
              </code>
            ) : null}
          </div>
          {deviceCode.acceptsCode ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim()) {
                  onSubmitCode?.(code.trim());
                }
              }}
            >
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Enter the provider code"
                aria-label="Provider code"
                className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground"
              />
              <Button type="submit" size="sm" disabled={!code.trim()}>
                Continue
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}

      {action ? (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={source.type === "local" ? "outline" : "default"}
            onClick={() => onAction(action)}
          >
            {ActionIcon ? <ActionIcon /> : null}
            {SOURCE_ACTION_META[action].label}
          </Button>
          {/* Make the no-secret boundary explicit next to the action. */}
          {source.type === "api-key" || source.type === "gateway" ? (
            <span className="text-label tracking-wider text-muted-foreground/70">
              keys stay in the host auth store
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
