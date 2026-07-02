import { describe, expect, test } from "vitest";
import { redactHookText } from "./redact";

describe("redactHookText - env-like assignments (D-009)", () => {
  test("an env-style KEY=value assignment loses its value", () => {
    const scrubbed = redactHookText("loaded AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI in env");
    expect(scrubbed).not.toContain("wJalrXUtnFEMI");
    expect(scrubbed).toContain("AWS_SECRET_ACCESS_KEY=");
  });

  test("multiple assignments on one line are all scrubbed", () => {
    const scrubbed = redactHookText("DB_PASSWORD=hunter2 API_KEY=abc123");
    expect(scrubbed).not.toContain("hunter2");
    expect(scrubbed).not.toContain("abc123");
  });

  test("prose without secrets passes through untouched", () => {
    expect(redactHookText("checked 3 files, all clean")).toBe("checked 3 files, all clean");
  });
});

describe("redactHookText - auth headers and tokens (D-009)", () => {
  test("a bearer authorization header loses its token", () => {
    const scrubbed = redactHookText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig");
    expect(scrubbed).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  test("an x-api-key header value is scrubbed", () => {
    const scrubbed = redactHookText('"x-api-key": "shhh-very-secret"');
    expect(scrubbed).not.toContain("shhh-very-secret");
  });

  test("a token-like sk- string is scrubbed even without a key name", () => {
    const scrubbed = redactHookText("using sk-abc123def456ghi789 for the call");
    expect(scrubbed).not.toContain("sk-abc123def456ghi789");
  });
});

describe("redactHookText - home paths (D-009)", () => {
  test("a macOS home path collapses to ~", () => {
    expect(redactHookText("wrote /Users/somebody/dev/proj/out.txt")).toBe(
      "wrote ~/dev/proj/out.txt",
    );
  });

  test("a linux home path collapses to ~", () => {
    expect(redactHookText("cache at /home/somebody/.cache/tool")).toBe("cache at ~/.cache/tool");
  });

  test("a non-home absolute path is left alone", () => {
    expect(redactHookText("read /etc/hosts")).toBe("read /etc/hosts");
  });
});

describe("redactHookText - idempotence", () => {
  test("re-redacting already-redacted text is a no-op", () => {
    const once = redactHookText(
      "TOKEN=abc123 at /Users/somebody/x Authorization: Bearer tok123456",
    );
    expect(redactHookText(once)).toBe(once);
  });
});
