import { describe, expect, it } from "vitest";
import { anthropicLimitEvent, failureLimitEvent } from "./usage-limit-capture";

/**
 * Plan 44.4 M2/M3: the pi-ai boundary's translation of provider usage-limit SIGNALS into a `limit`
 * ProviderEvent - Claude's success-path `anthropic-ratelimit-unified-*` response headers (M2), and a
 * Codex/OpenAI error-path rate/quota failure classified detect-only "reached" (M3).
 */

describe("anthropicLimitEvent (M2 - Claude success headers)", () => {
  it("maps allowed_warning unified headers into an approaching limit ProviderEvent", () => {
    const event = anthropicLimitEvent({
      "anthropic-ratelimit-unified-status": "allowed_warning",
      "anthropic-ratelimit-unified-5h-status": "allowed_warning",
      "anthropic-ratelimit-unified-5h-reset": "2026-07-05T00:00:00Z",
      "anthropic-ratelimit-unified-5h-remaining": "5",
      "anthropic-ratelimit-unified-5h-limit": "100",
    });
    expect(event).toEqual({
      type: "limit",
      status: "approaching",
      scope: "five_hour",
      resetsAt: Date.parse("2026-07-05T00:00:00Z") / 1000,
      utilization: 0.95,
    });
  });

  it("maps rejected -> reached", () => {
    const event = anthropicLimitEvent({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-7d-status": "rejected",
    });
    expect(event?.type).toBe("limit");
    expect(event?.status).toBe("reached");
    expect(event?.scope).toBe("seven_day");
  });

  it("returns null when the response carries no unified rate-limit headers", () => {
    expect(anthropicLimitEvent({ "content-type": "application/json" })).toBeNull();
  });

  it("returns null for the steady-state `allowed` (ok) that rides every successful response", () => {
    // Anthropic sends the unified-status header on EVERY success; `allowed` -> "ok" must NOT surface a
    // marker, or every Claude turn would carry an "all good" limit row.
    expect(
      anthropicLimitEvent({
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-5h-status": "allowed",
        "anthropic-ratelimit-unified-5h-reset": "2026-07-05T00:00:00Z",
      }),
    ).toBeNull();
  });
});

describe("failureLimitEvent (M3 - Codex error path, detect-only)", () => {
  it("classifies a 429 message as a reached limit (no reset when none is exposed)", () => {
    const event = failureLimitEvent(
      new Error("429 Rate limit reached for gpt-5.5"),
      "codex",
      Date.parse("2026-07-04T12:00:00Z"),
    );
    expect(event).toEqual({ type: "limit", status: "reached", scope: "unknown" });
  });

  it("populates resetsAt from a retry-after header when the provider exposes one", () => {
    const now = Date.parse("2026-07-04T12:00:00Z");
    const event = failureLimitEvent(
      { status: 429, message: "Rate limit reached", headers: { "retry-after": "120" } },
      "codex",
      now,
    );
    // retry-after (a DELTA of 120s) becomes an absolute reset: now + 120s, in epoch seconds.
    expect(event?.resetsAt).toBe(Math.floor(now / 1000) + 120);
    expect(event?.status).toBe("reached");
  });

  it("treats a hard quota/billing failure as reached too", () => {
    const event = failureLimitEvent(
      { status: 429, message: "You exceeded your current quota", code: "insufficient_quota" },
      "codex",
    );
    expect(event?.status).toBe("reached");
  });

  it("returns null for a non-limit failure (auth, transport, overflow)", () => {
    expect(failureLimitEvent(new Error("401 Unauthorized"), "codex")).toBeNull();
    expect(failureLimitEvent(new Error("ECONNRESET"), "codex")).toBeNull();
    expect(failureLimitEvent(new Error("context length exceeded"), "codex")).toBeNull();
  });

  it("classifies the Codex streaming usage-limit error as a reached limit (detect-only)", () => {
    // The streaming path collapses to just this message - the structured resets_at is dropped inside
    // pi-ai before we see it, so this is detect-only (a marker with no reset time).
    const event = failureLimitEvent(
      new Error("Codex error: The usage limit has been reached"),
      "codex",
      Date.parse("2026-07-04T12:00:00Z"),
    );
    expect(event).toEqual({ type: "limit", status: "reached", scope: "unknown" });
  });

  it("recovers resetsAt from the ChatGPT usage-limit reset wording when no header is present", () => {
    const now = Date.parse("2026-07-04T12:00:00Z");
    // pi-ai's Codex HTTP path builds this sentence from resets_at; the prose is the only reset left.
    const event = failureLimitEvent(
      new Error("You have hit your ChatGPT usage limit (pro plan). Try again in ~42 min."),
      "codex",
      now,
    );
    expect(event?.status).toBe("reached");
    expect(event?.resetsAt).toBe(Math.floor(now / 1000) + 42 * 60);
  });

  it("parses hour/second reset wording too", () => {
    const now = Date.parse("2026-07-04T12:00:00Z");
    expect(
      failureLimitEvent(new Error("usage limit reached. Try again in 2 hours"), "codex", now)
        ?.resetsAt,
    ).toBe(Math.floor(now / 1000) + 2 * 3600);
    expect(
      failureLimitEvent(new Error("usage limit reached; resets in 30 seconds"), "codex", now)
        ?.resetsAt,
    ).toBe(Math.floor(now / 1000) + 30);
  });

  it("prefers a retry-after header over the message wording when both are present", () => {
    const now = Date.parse("2026-07-04T12:00:00Z");
    const event = failureLimitEvent(
      {
        status: 429,
        message: "You have hit your ChatGPT usage limit. Try again in ~42 min.",
        headers: { "retry-after": "120" },
      },
      "codex",
      now,
    );
    expect(event?.resetsAt).toBe(Math.floor(now / 1000) + 120);
  });
});
