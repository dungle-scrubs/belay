# @trevor/sdk - Agent Instructions

`@trevor/sdk` is the ergonomic, browser-safe **headless workflow layer above `@trevor/session`** (plan
28). It productizes non-web access to Trevor for automation, scripts, evals, and other TypeScript
consumers: bind a client to a backend by URL, then read the inventory/transcript, prompt/stream/cancel a
turn, switch the model mid-turn, upload/download artifacts, read capabilities/doctor, and run session
lifecycle.

## Boundaries (do not cross)

- **The SDK does not run the CLI.** It talks to the session-store / Richter / blob-store through the
  `@trevor/session` protocol only, never by shelling out (D-002). No import of `@trevor/cli`.
- **The SDK is not a second protocol package.** It imports `@trevor/session` primitives
  (`SessionTransport`, `events`, decoders, `streamTransport`, blob client) rather than re-deriving event
  or session types (D-001). If you need a wire type, import it from `@trevor/session`.
- **The SDK does not recreate the web UI.** It exposes data and operations (transcript projection,
  workflows), not visual surfaces like the artifact panel or model chooser (they stay web-owned).
- **Backend selection is URL-based.** A local session-store and a Richter service speak the identical
  `/sessions` wire, so the choice is just the URL passed to `createTrevorClient`. There is no
  `@trevor/richter` adapter package (D-004).
- **Local process orchestration is NOT here.** Starting services, spawning/reusing hosts, opening the
  browser, and OS signals (stop/kill) live in `apps/trevor-cli`, not in this browser-safe core (D-003).
  The SDK owns protocol-safe operations only: `cancel` (a `user.cancel` control event) is here;
  `stop`/`kill` (process signals) are not.
- **No hidden `ask()` shortcut.** Prompting is session-oriented: submit a prompt and stream the turn
  separately, so streaming/cancellation/switching compose. Do not add a one-shot routing API.

## Structure

- `client.ts` - `createTrevorClient` + the `TrevorClient` facade over the bound transport.
- `errors.ts` - the structured `SdkError` (operation, backend, session id, redacted URL class, detail).
- `identity.ts` - the default non-host viewer identity + producer a headless client presents.
- `artifacts.ts` / `transcript.ts` / `capabilities.ts` / `prompt.ts` / `lifecycle.ts` - the workflows,
  each a set of pure-ish functions the client composes and re-exports.

The pure lifecycle logic (`selectSessions`, `resolveOpenTarget`, `expandHome`) is the SINGLE source the
CLI re-exports, so CLI and SDK cannot drift.

## Public API status (plan 28 M11)

The package barrel `src/index.ts` IS the public surface. Everything exported there is intended for
consumers (automation, evals, the CLI, harnesses) and is covered by the package-boundary test
(`src/boundary.test.ts`):

- **Public / stable:** `createTrevorClient` + `TrevorClient` and its methods; the workflow functions and
  their input/result types (`PromptInput`, `StreamTurnOptions`, `TurnResult`, `SwitchModelInput`,
  `ModelSwitchRecord`, `Transcript`/`TranscriptEntry`, `CommandResult`, `ManifestExport`,
  `ArtifactSource`); the structured `SdkError` + `isSdkError`; and the identity constants
  (`DEFAULT_SDK_PRODUCER_ID`, `SDK_DISPLAY_NAME`, `sdkIdentity`).
- **Internal (not exported from the barrel):** the per-workflow module internals that only the
  `TrevorClient` composes, and `errors.ts` helpers `withSdkError` / `urlClass` (used by the client and
  workflows, not part of the consumer contract). Import wire types from `@trevor/session`, not from here.

Consumers that drive Trevor end-to-end (the eval/automation harness, the headless CLI) build ONLY on
this barrel and the session protocol - one protocol, three consumers (SDK, CLI, test-kit/harness), all
covered by e2e (`e2e/cli-headless.test.ts`, `e2e/eval-harness.test.ts`).

## Testing

Unit tests are co-located (`src/*.test.ts`) and drive an in-memory recording transport; integration
tests (`test/*.test.ts`) boot a real session-store / blob-store on ephemeral ports via
`@trevor/test-kit/boot`. See the repo-root `AGENTS.md` "Testing" section.

The eval/automation harness (M10) lives in `apps/agent-host/test/support` (re-exported via
`@trevor/agent-host/testing`), because attaching a fake-provider host needs the host's turn pipeline;
test-kit stays test-only and never depends on the host (`packages/test-kit/test/boundary.test.ts`).
