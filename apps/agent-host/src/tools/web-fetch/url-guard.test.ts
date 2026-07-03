import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assertSafeRedirect,
  assertSafeRedirectAsync,
  assertSafeUrl,
  assertSafeUrlAsync,
  UnsafeUrlError,
} from "./url-guard";

/**
 * SSRF guard coverage. Every rejection class the plan names is pinned both as an IP literal and
 * (where a hostname can carry it) via an injected resolver, plus the safe-URL pass path and the
 * redirect rules (safe hop, private hop blocked, scheme downgrade blocked, loop detected). The
 * guard MUST reject before any network IO, so each rejection is a thrown UnsafeUrlError.
 */

function rejects(raw: string, resolve?: (host: string) => readonly string[]): UnsafeUrlError {
  try {
    assertSafeUrl(raw, resolve);
  } catch (error) {
    assert.ok(error instanceof UnsafeUrlError, `expected UnsafeUrlError for ${raw}`);
    return error;
  }

  throw new assert.AssertionError({ message: `expected ${raw} to be rejected` });
}

test("safe public http(s) URLs pass and return the parsed URL", () => {
  const url = assertSafeUrl("https://example.com/path?q=1#frag");
  assert.equal(url.hostname, "example.com");

  assert.equal(assertSafeUrl("http://example.org").protocol, "http:");
});

test("non-http(s) schemes are rejected", () => {
  for (const raw of [
    "ftp://example.com",
    "file:///etc/passwd",
    "data:text/plain,hi",
    "gopher://example.com",
    "javascript:alert(1)",
  ]) {
    rejects(raw);
  }
});

test("malformed URLs are rejected", () => {
  for (const raw of ["not a url", "http://", "://example.com", ""]) {
    rejects(raw);
  }
});

test("URLs carrying userinfo are rejected", () => {
  rejects("https://user:pass@example.com/");
  rejects("https://user@example.com/");
});

test("loopback hosts and addresses are rejected", () => {
  rejects("http://localhost/");
  rejects("http://sub.localhost/");
  rejects("http://127.0.0.1/");
  rejects("http://127.5.5.5/");
  rejects("http://[::1]/");
});

test("private IPv4 ranges are rejected", () => {
  rejects("http://10.0.0.1/");
  rejects("http://10.255.255.255/");
  rejects("http://172.16.0.1/");
  rejects("http://172.31.255.255/");
  rejects("http://192.168.1.1/");
});

test("link-local and cloud metadata addresses are rejected", () => {
  rejects("http://169.254.0.1/");
  rejects("http://169.254.169.254/");
  rejects("http://[fe80::1]/");
});

test("IPv6 unique-local addresses are rejected", () => {
  rejects("http://[fc00::1]/");
  rejects("http://[fd12:3456::1]/");
});

test("the unspecified address and IPv4-mapped private IPv6 are rejected", () => {
  rejects("http://0.0.0.0/");
  rejects("http://[::ffff:127.0.0.1]/");
  rejects("http://[::ffff:10.0.0.1]/");
});

test("a hostname resolving to a private address is rejected via the injected resolver", () => {
  rejects("https://evil.example.com/", () => ["192.168.0.5"]);
  rejects("https://evil.example.com/", () => ["169.254.169.254"]);
  rejects("https://evil.example.com/", () => ["8.8.8.8", "10.0.0.1"]);
});

test("a hostname resolving only to public addresses passes", () => {
  const url = assertSafeUrl("https://good.example.com/", () => ["93.184.216.34"]);
  assert.equal(url.hostname, "good.example.com");
});

test("async URL guard owns DNS resolution", async () => {
  const url = await assertSafeUrlAsync("https://good.example.com/", async () => ["93.184.216.34"]);
  assert.equal(url.hostname, "good.example.com");
  await assert.rejects(
    () => assertSafeUrlAsync("https://evil.example.com/", async () => ["10.0.0.5"]),
    UnsafeUrlError,
  );
});

test("resolution failure or no addresses is treated as unknown and rejected", () => {
  rejects("https://mystery.example.com/", () => {
    throw new Error("ENOTFOUND");
  });
  rejects("https://mystery.example.com/", () => []);
});

test("a hostname with no resolver injected passes (literal-only guard, DNS unavailable)", () => {
  const url = assertSafeUrl("https://example.com/");
  assert.equal(url.hostname, "example.com");
});

test("a safe redirect hop resolves and passes the guard", () => {
  const from = new URL("https://example.com/a");
  const target = assertSafeRedirect({ from, to: "/b" }, new Set());
  assert.equal(target.toString(), "https://example.com/b");
});

test("async redirect guard resolves the target host before accepting a hop", async () => {
  const from = new URL("https://example.com/a");
  const target = await assertSafeRedirectAsync(
    { from, to: "https://good.example.com/b" },
    new Set(),
    async () => ["93.184.216.34"],
  );
  assert.equal(target.toString(), "https://good.example.com/b");
});

test("a redirect to a private target is blocked", () => {
  const from = new URL("https://example.com/a");
  assert.throws(
    () => assertSafeRedirect({ from, to: "http://169.254.169.254/latest/meta-data" }, new Set()),
    UnsafeUrlError,
  );
});

test("a redirect that downgrades https to http is blocked", () => {
  const from = new URL("https://example.com/a");
  assert.throws(
    () => assertSafeRedirect({ from, to: "http://example.com/b" }, new Set()),
    /downgrade/,
  );
});

test("a redirect revisiting a seen URL is detected as a loop", () => {
  const from = new URL("https://example.com/a");
  const seen = new Set(["https://example.com/a"]);
  assert.throws(() => assertSafeRedirect({ from, to: "https://example.com/a" }, seen), /loop/);
});
