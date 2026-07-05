import assert from "node:assert/strict";
import { test, vi } from "vitest";

/**
 * Pins the Claude sign-in's paste/remote fallback wiring (53.1). pi-ai's `loginAnthropic` completes via
 * its localhost callback server on the same machine, but a browser that cannot reach 127.0.0.1 (a
 * remote/headless host) must paste the redirect code - which pi-ai drives through `onManualCodeInput`
 * (raced against the callback server), NOT `onPrompt` (unreachable while the server waits). This mocks
 * `loginAnthropic` to assert `anthropicLogin` wires `onManualCodeInput` to the host's `requestCode`, so a
 * regression that drops the fallback (silently hanging remote sign-in) is caught. The real login is
 * mocked because a live run opens a browser + binds a port.
 */

const { loginAnthropicMock } = vi.hoisted(() => ({
  loginAnthropicMock: vi.fn(async (_opts: unknown) => ({
    access: "sk-ant-oat-test",
    refresh: "r",
    expires: 0,
  })),
}));

vi.mock("@earendil-works/pi-ai/oauth", () => ({ loginAnthropic: loginAnthropicMock }));

import { signInTargetFor } from "./provider-auth";

test("the Claude sign-in wires the paste fallback (onManualCodeInput -> requestCode)", async () => {
  const requestCode = vi.fn(async () => "pasted-code");
  const target = signInTargetFor("anthropic");
  assert.ok(target, "the anthropic source has a sign-in target");

  await target.login({
    onDeviceCode: vi.fn(),
    onAuthUrl: vi.fn(),
    requestCode,
    signal: new AbortController().signal,
  });

  const opts = loginAnthropicMock.mock.calls[0]?.[0] as {
    onManualCodeInput?: () => Promise<string>;
  };
  assert.ok(opts.onManualCodeInput, "the remote/busy-port paste fallback is wired");
  await opts.onManualCodeInput?.();
  assert.equal(requestCode.mock.calls.length, 1, "the paste fallback drives the host requestCode");
});
