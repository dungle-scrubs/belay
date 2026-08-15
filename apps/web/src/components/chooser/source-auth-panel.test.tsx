import assert from "node:assert/strict";
import type { SourceAction, SourceSummary } from "@belay/session";
import { fireEvent, render } from "@testing-library/react";
import { test } from "vitest";
import { authCopy, needsAuthPanel, SourceAuthPanel } from "./source-auth-panel";

/**
 * D-065 M5: the no-secret authentication / setup boundary. Pins OAuth sign-in/re-login, the device /
 * provider-code flow (link + non-key code), the direct-API-key host-store states (missing / rejected),
 * local runtime setup guidance, and - the load-bearing invariant - that the chooser NEVER renders an
 * API-key paste form.
 */

function source(over: Partial<SourceSummary> & { sourceId: string }): SourceSummary {
  return {
    type: "api-key",
    label: `Source ${over.sourceId}`,
    status: "ready",
    modelCount: 0,
    auth: "none",
    freshness: { refreshedAt: null, stale: false },
    actions: [],
    ...over,
  };
}

const noop = () => {};

/** Asserts the rendered panel has NO API-key paste form: no password input, and no input named for a key. */
function assertNoKeyInput(container: HTMLElement) {
  assert.equal(container.querySelector('input[type="password"]'), null, "no password field");
  for (const input of container.querySelectorAll("input")) {
    const label = (input.getAttribute("aria-label") ?? "").toLowerCase();
    const placeholder = (input.getAttribute("placeholder") ?? "").toLowerCase();
    assert.ok(!/\bapi[\s_-]?key\b|secret|token/.test(label), `input not a key field: ${label}`);
    assert.ok(!/\bapi[\s_-]?key\b|secret|token/.test(placeholder), `input not a key field`);
  }
}

test("needsAuthPanel is false for an authenticated, ready source", () => {
  assert.equal(
    needsAuthPanel(
      source({ sourceId: "a", type: "oauth", status: "ready", auth: "authenticated" }),
    ),
    false,
  );
  assert.equal(
    needsAuthPanel(
      source({ sourceId: "b", type: "api-key", status: "ready", auth: "authenticated" }),
    ),
    false,
  );
});

test("OAuth signed-out shows a Sign in action and no key input", () => {
  const actions: SourceAction[] = [];
  const { getByRole, container } = render(
    <SourceAuthPanel
      source={source({
        sourceId: "codex",
        type: "oauth",
        status: "needs-auth",
        auth: "none",
        actions: ["authenticate"],
        label: "OpenAI",
      })}
      onAction={(a) => actions.push(a)}
    />,
  );
  const btn = getByRole("button", { name: "Sign in" });
  fireEvent.click(btn);
  assert.deepEqual(actions, ["authenticate"]);
  assertNoKeyInput(container);
});

test("OAuth expired shows a Re-authenticate action and expired copy", () => {
  const expired = source({
    sourceId: "claude",
    type: "oauth",
    status: "needs-auth",
    auth: "expired",
    actions: ["reauthenticate"],
  });
  assert.match(authCopy(expired).title, /expired/i);
  const { getByRole } = render(<SourceAuthPanel source={expired} onAction={noop} />);
  assert.ok(getByRole("button", { name: "Re-authenticate" }));
});

test("the Claude subscription (oauth + authenticate) shows an in-app Sign in, not setup-token guidance", () => {
  // 53.1 D-001: the ONE Claude subscription is an oauth source with a real in-app OAuth (loginAnthropic
  // PKCE), so the host offers it `authenticate` - the panel must show the "Sign in to Claude
  // subscription" copy + a Sign in button, NOT the old `claude setup-token` configure guidance.
  const subscription = source({
    sourceId: "anthropic",
    type: "oauth",
    status: "needs-auth",
    auth: "none",
    actions: ["authenticate"],
    label: "Claude subscription",
  });
  const copy = authCopy(subscription);
  assert.match(copy.title, /sign in to claude subscription/i);
  assert.doesNotMatch(copy.body, /setup-token/i);
  const actions: SourceAction[] = [];
  const { getByRole, container } = render(
    <SourceAuthPanel source={subscription} onAction={(a) => actions.push(a)} />,
  );
  const btn = getByRole("button", { name: "Sign in" });
  fireEvent.click(btn);
  assert.deepEqual(actions, ["authenticate"], "a real sign-in action, not configure");
  assertNoKeyInput(container);
});

test("a device-code sign-in for the Claude subscription renders the loginAnthropic link + paste field", () => {
  // 53.1 R-2: when loginAnthropic's localhost callback port is busy, the host emits a `device-code`
  // SourceSignInState with the verification URL + acceptsCode, and the panel renders the
  // DeviceCodeFlow (the long-URL fixture keeps the 53 D-004 wrap honest).
  const longUrl = `https://claude.ai/oauth/authorize?client_id=belay&scope=all&state=${"y".repeat(240)}`;
  const codes: string[] = [];
  const { getByText, getByLabelText, getByRole, container } = render(
    <SourceAuthPanel
      source={source({
        sourceId: "anthropic",
        type: "oauth",
        status: "needs-auth",
        auth: "none",
        actions: ["authenticate"],
        label: "Claude subscription",
      })}
      deviceCode={{ verificationUrl: longUrl, acceptsCode: true }}
      onAction={noop}
      onSubmitCode={(c) => codes.push(c)}
    />,
  );
  const urlText = getByText(longUrl);
  assert.equal(
    urlText.closest("a")?.getAttribute("href"),
    longUrl,
    "the verification URL is a link",
  );
  assert.ok(
    urlText.className.includes("break-all"),
    "the long URL breaks between characters (D-004)",
  );
  const codeInput = getByLabelText("Provider code");
  fireEvent.change(codeInput, { target: { value: "pasted-oauth-code" } });
  fireEvent.click(getByRole("button", { name: "Continue" }));
  assert.deepEqual(codes, ["pasted-oauth-code"], "the pasted redirect code is submitted");
  assertNoKeyInput(container);
});

test("the Anthropic Direct API (api-key, `anthropic-api`) points to ~/.pi/auth.json with a Configure, not Sign in", () => {
  // 53.1 D-001: the Direct API is a static-key peer on the DISTINCT `anthropic-api` id (the OAuth
  // subscription owns `anthropic`). Its copy points at the host auth store and it offers `configure` -
  // never a provider sign-in, and never an in-browser key field.
  const missing = source({
    sourceId: "anthropic-api",
    label: "Anthropic Direct API",
    type: "api-key",
    status: "ready",
    auth: "none",
    actions: ["configure"],
  });
  const copy = authCopy(missing);
  assert.match(copy.title, /no api key/i);
  assert.match(copy.body, /~\/\.pi\/auth\.json/);
  const { getByRole, queryByRole, container, getByText } = render(
    <SourceAuthPanel source={missing} onAction={noop} />,
  );
  assert.ok(getByRole("button", { name: "Configure" }), "a Configure action (not a paste form)");
  assert.equal(queryByRole("button", { name: "Sign in" }), null, "never a provider sign-in button");
  assert.ok(getByText(/keys stay in the host auth store/i), "the no-secret boundary is explicit");
  assertNoKeyInput(container);
});

test("a rejected API key explains the rejection and still shows no key field", () => {
  const rejected = source({
    sourceId: "openai",
    type: "api-key",
    status: "error",
    auth: "authenticated",
    actions: ["configure"],
  });
  assert.match(authCopy(rejected).title, /rejected/i);
  const { container } = render(<SourceAuthPanel source={rejected} onAction={noop} />);
  assertNoKeyInput(container);
});

test("a local runtime shows setup guidance without claiming to install it", () => {
  const local = source({
    sourceId: "lmstudio",
    type: "local",
    status: "unavailable",
    auth: "none",
    actions: ["configure"],
    label: "LM Studio",
  });
  const copy = authCopy(local);
  assert.match(copy.title, /start the local runtime/i);
  assert.match(copy.body, /does not install or manage/i);
  const { container } = render(<SourceAuthPanel source={local} onAction={noop} />);
  assertNoKeyInput(container);
});

test("a device / provider-code flow shows the link + non-key code and submits a typed code", () => {
  const codes: string[] = [];
  const { getByText, getByLabelText, getByRole, container } = render(
    <SourceAuthPanel
      source={source({
        sourceId: "codex",
        type: "oauth",
        status: "needs-auth",
        auth: "none",
        actions: ["authenticate"],
      })}
      deviceCode={{
        verificationUrl: "https://auth.example.com/device",
        userCode: "WDJB-MJHT",
        acceptsCode: true,
      }}
      onAction={noop}
      onSubmitCode={(c) => codes.push(c)}
    />,
  );
  // The verification link + the short user code are shown.
  const link = getByText("https://auth.example.com/device").closest("a");
  assert.equal(link?.getAttribute("href"), "https://auth.example.com/device");
  assert.ok(getByText("WDJB-MJHT"), "the device code is shown");

  // The code input is a PROVIDER CODE field, not an API key, and submitting calls onSubmitCode.
  const codeInput = getByLabelText("Provider code");
  assert.notEqual(codeInput.getAttribute("aria-label")?.toLowerCase(), "api key");
  fireEvent.change(codeInput, { target: { value: "user-entered-code" } });
  fireEvent.click(getByRole("button", { name: "Continue" }));
  assert.deepEqual(codes, ["user-entered-code"]);
  assertNoKeyInput(container);
});

test("a long verification URL wraps instead of overflowing the panel (53 D-004)", () => {
  const longUrl = `https://auth.example.com/oauth/device/authorize?client_id=belay&scope=all&state=${"x".repeat(240)}`;
  const { getByText } = render(
    <SourceAuthPanel
      source={source({
        sourceId: "codex",
        type: "oauth",
        status: "needs-auth",
        auth: "none",
        actions: ["authenticate"],
      })}
      deviceCode={{ verificationUrl: longUrl, acceptsCode: true }}
      onAction={noop}
    />,
  );
  // jsdom does not lay out, so the anti-overflow guarantee is asserted structurally: the URL text
  // carries `break-all` (breaks between characters) inside a `flex-wrap` row, so a long URL wraps
  // within the panel rather than forcing horizontal overflow.
  const urlText = getByText(longUrl);
  assert.ok(urlText.className.includes("break-all"), "the URL text breaks between characters");
  const row = urlText.closest("a")?.parentElement;
  assert.ok(row?.className.includes("flex-wrap"), "the link + code row wraps");
});

test("an auth failure is scoped to the panel - it renders only this source's state", () => {
  // The panel takes ONE source; it has no handle to other sources, so a failure here cannot block
  // browsing or selecting unrelated sources (that lives in the chooser, which keeps the overview).
  const { container } = render(
    <SourceAuthPanel
      source={source({
        sourceId: "x",
        type: "oauth",
        status: "error",
        auth: "expired",
        actions: ["reauthenticate"],
      })}
      onAction={noop}
    />,
  );
  const section = container.querySelector('[aria-label="Source authentication"]');
  assert.ok(section, "the panel is one self-contained section");
  assertNoKeyInput(container);
});

test("the starting phase shows immediate progress (the click is never a silent no-op)", () => {
  // The host emits `starting` the moment /source-signin lands; before this state existed, the
  // seconds-long gap while the login minted its URL read as a dead Re-authenticate button (and
  // invited re-clicks that each restarted the flow).
  const expired = source({
    sourceId: "anthropic",
    type: "oauth",
    status: "needs-auth",
    auth: "expired",
    actions: ["reauthenticate"],
  });
  const started = render(<SourceAuthPanel source={expired} starting onAction={noop} />);
  started.getByText(/contacting the provider/i);
  assertNoKeyInput(started.container);
  started.unmount();

  // Without the flag there is no progress line (the copy + button render as before).
  const idle = render(<SourceAuthPanel source={expired} onAction={noop} />);
  assert.equal(idle.queryByText(/contacting the provider/i), null);
});
