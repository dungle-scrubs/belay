import type { EmitEvent } from "@host/transport/services";
import { events } from "@trevor/session";
import { runSourceSignIn, SOURCE_AUTH_PATH, signInTargetFor } from "./provider-auth";

/**
 * Host-driven source SIGN-IN (D-065 M5), extracted from main.ts (plan 22.2 M2): the chooser's
 * authenticate/re-authenticate action asks the host to run an OAuth device-code flow. The host emits
 * the device code (URL + short code), waits for the user to authorize, persists the credential, and
 * refreshes the catalog so the source flips to ready. One flow at a time - a new sign-in (or a
 * cancel) aborts the in-flight one. main.ts constructs {@link makeSourceSignIn} once and dispatches
 * the /source-signin, /source-signin-cancel, and /source-signin-code command arms here.
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
}

/** Builds the sign-in flow over the host's live emit + catalog refresh; main.ts wires it once. */
export function makeSourceSignIn(deps: SourceSignInDeps) {
  const { emit, refreshCatalog } = deps;

  let signInAbort: AbortController | null = null;
  // The browser+paste flow (Anthropic) awaits a user-pasted code; `/source-signin-code` resolves this.
  let signInCodeResolver: ((code: string) => void) | null = null;

  function startSourceSignIn(sourceId: string): void {
    const target = signInTargetFor(sourceId);
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
    let completed = false;
    void runSourceSignIn({
      sourceId,
      oauthName: target.oauthName,
      login: target.login,
      authPath: SOURCE_AUTH_PATH,
      signal: controller.signal,
      emit: (state) => {
        if (state.phase === "complete") {
          completed = true;
        }
        void emit(events.hostSourceAuth({ state }));
      },
      // Browser+paste flow: hold the resolver until `/source-signin-code` arrives; reject on abort so
      // the login unwinds to a cancelled phase.
      requestCode: () =>
        new Promise<string>((resolve, reject) => {
          if (controller.signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signInCodeResolver = resolve;
          controller.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    }).then(() => {
      if (signInAbort === controller) {
        signInAbort = null;
      }
      signInCodeResolver = null;
      // Re-read auth only on success: the new credential makes the source ready in the next catalog.
      if (completed) {
        refreshCatalog();
      }
    });
  }

  /** handleEvent's `/source-signin-cancel` arm: abort the in-flight flow (a no-op when none is). */
  function cancelSignIn(): void {
    signInAbort?.abort();
  }

  /** handleEvent's `/source-signin-code` arm: resolve the pending browser+paste wait with the code. */
  function submitSignInCode(code: string): void {
    signInCodeResolver?.(code);
    signInCodeResolver = null;
  }

  return { startSourceSignIn, cancelSignIn, submitSignInCode };
}
