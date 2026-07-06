import type { EmitEvent } from "@host/transport/services";
import { events } from "@trevor/session";
import {
  type OAuthLogin,
  runSourceSignIn,
  SOURCE_AUTH_PATH,
  signInTargetFor,
} from "./provider-auth";

/**
 * Host-driven source SIGN-IN (D-065 M5), extracted from main.ts (plan 22.2 M2): the chooser's
 * authenticate/re-authenticate action asks the host to run an OAuth device-code flow. The host emits
 * `starting` IMMEDIATELY (a login can take seconds to produce its URL, and a silent gap reads as a
 * dead button), then the device code (URL + short code), waits for the user to authorize, persists
 * the credential, and refreshes the catalog so the source flips to ready. One flow at a time - a new
 * sign-in (or a cancel) SUPERSEDES the in-flight one: the old flow is aborted, and because a login
 * can't always be unwound (pi-ai's browser+paste flow takes no abort signal), every emission and
 * code-resolver registration from a superseded flow is DROPPED so its zombie events can't flap the
 * live flow's state (the observed device-code/cancelled interleaving). main.ts constructs
 * {@link makeSourceSignIn} once and dispatches the /source-signin, /source-signin-cancel, and
 * /source-signin-code command arms here.
 *
 * Responsible for: the /source-signin start/cancel/code command flow and its one-at-a-time state.
 * Not for: the OAuth flows themselves (provider-auth.ts) or catalog loading (catalog.ts - main.ts
 * wires its refresh in as a dep).
 */

/** The live main.ts effects the flow runs through - the event publisher and the catalog refresh. */
export interface SourceSignInDeps {
  /** Publish one host-authored event to the durable log (main.ts's emit). */
  readonly emit: EmitEvent;
  /** Re-read auth + re-query sources so a fresh credential flips the source to ready. */
  refreshCatalog(): void;
  /** The sign-in flow for a source id (defaults to the real registry); a test injects a fake login. */
  readonly targetFor?: (sourceId: string) => { oauthName: string; login: OAuthLogin } | null;
  /** The credential store a completed sign-in writes to (defaults to ~/.pi/auth.json); tests inject
   *  a temp file so a completing fake flow can never touch the real store. */
  readonly authPath?: string;
}

/** Builds the sign-in flow over the host's live emit + catalog refresh; main.ts wires it once. */
export function makeSourceSignIn(deps: SourceSignInDeps) {
  const { emit, refreshCatalog } = deps;
  const targetFor = deps.targetFor ?? signInTargetFor;
  const authPath = deps.authPath ?? SOURCE_AUTH_PATH;

  let signInAbort: AbortController | null = null;
  let signInSourceId: string | null = null;
  // The browser+paste flow (Anthropic) awaits a user-pasted code; `/source-signin-code` resolves this.
  let signInCodeResolver: ((code: string) => void) | null = null;

  function startSourceSignIn(sourceId: string): void {
    const target = targetFor(sourceId);
    if (!target) {
      void emit(
        events.hostSourceAuth({
          state: { sourceId, phase: "error", detail: "this source has no sign-in flow" },
        }),
      );
      return;
    }
    signInAbort?.abort();
    const controller = new AbortController();
    signInAbort = controller;
    signInSourceId = sourceId;
    // The flow this closure belongs to is CURRENT only while `signInAbort === controller`; a
    // superseded/cancelled flow may keep running (the login can't always be aborted), so everything
    // it does later is gated on still being current.
    const current = (): boolean => signInAbort === controller;
    let completed = false;
    // Instant feedback: the chooser shows "contacting the provider" from the first frame instead of
    // a dead-looking button while the login builds its URL (PKCE + a localhost callback server).
    void emit(events.hostSourceAuth({ state: { sourceId, phase: "starting" } }));
    void runSourceSignIn({
      sourceId,
      oauthName: target.oauthName,
      login: target.login,
      authPath,
      signal: controller.signal,
      emit: (state) => {
        // Drop a superseded flow's emissions: its late device-code/cancelled would overwrite the
        // live flow's state in every consumer that folds "latest sourceAuth wins".
        if (!current()) {
          return;
        }
        if (state.phase === "complete") {
          completed = true;
        }
        void emit(events.hostSourceAuth({ state }));
      },
      // Browser+paste flow: hold the resolver until `/source-signin-code` arrives; reject on abort so
      // the login unwinds to a cancelled phase. A superseded flow's late registration must not
      // clobber the LIVE flow's resolver, so it rejects instead of registering.
      requestCode: () =>
        new Promise<string>((resolve, reject) => {
          if (controller.signal.aborted || !current()) {
            reject(new Error("aborted"));
            return;
          }
          signInCodeResolver = resolve;
          controller.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    }).then(() => {
      // Only the CURRENT flow may clear the shared state - a zombie's completion must not null the
      // successor's abort handle or its pending code resolver.
      if (current()) {
        signInAbort = null;
        signInSourceId = null;
        signInCodeResolver = null;
      }
      // Re-read auth only on success: the new credential makes the source ready in the next catalog.
      // A superseded flow that still completed DID persist a valid credential, so refresh for it too.
      if (completed) {
        refreshCatalog();
      }
    });
  }

  /**
   * handleEvent's `/source-signin-cancel` arm: abort the in-flight flow (a no-op when none is) and
   * emit the cancelled state HERE. The flow's own catch can't be relied on for it - a login that
   * ignores the abort signal (Anthropic's browser+paste) may never unwind, which would leave the
   * chooser stuck on starting/device-code forever.
   */
  function cancelSignIn(): void {
    if (!signInAbort || signInSourceId === null) {
      return;
    }
    const sourceId = signInSourceId;
    const controller = signInAbort;
    // Clear the current markers FIRST so the aborted flow's own late "cancelled" (and anything else
    // it emits while winding down) is dropped by the currency gate - this emit is the one truth.
    signInAbort = null;
    signInSourceId = null;
    signInCodeResolver = null;
    controller.abort();
    void emit(events.hostSourceAuth({ state: { sourceId, phase: "cancelled" } }));
  }

  /** handleEvent's `/source-signin-code` arm: resolve the pending browser+paste wait with the code. */
  function submitSignInCode(code: string): void {
    signInCodeResolver?.(code);
    signInCodeResolver = null;
  }

  return { startSourceSignIn, cancelSignIn, submitSignInCode };
}
