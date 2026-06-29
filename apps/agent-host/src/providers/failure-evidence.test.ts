import { describe, expect, it } from "vitest";
import { causeChainDetail, extractFailureEvidence } from "./failure-evidence";
import { classifyProviderFailure, redactSecrets } from "./failure-taxonomy";

/**
 * D-076 M2: the provider boundary preserves retry-after, HTTP status, SDK code/type, the provider
 * request id, gateway-vs-upstream origin, and the local runtime error class off realistic, SANITIZED
 * SDK-shaped fixtures (Codex/OpenAI OAuth, Anthropic-like OAuth, direct API key, gateway, local
 * runtime). Every fixture asserts BOTH the classification and that the evidence carries shape, never a
 * secret value.
 */

/** Builds a redacted detail the way the boundary does, to assert the same classification path. */
function evidenceClass(cause: unknown, opts?: { local?: boolean; gateway?: boolean }) {
  const evidence = extractFailureEvidence(cause, { gateway: opts?.gateway });
  const failure = classifyProviderFailure({
    detail: String((cause as { message?: string })?.message ?? ""),
    status: evidence.status,
    code: evidence.code,
    retryAfterMs: evidence.retryAfterMs,
    local: opts?.local,
  });
  return { evidence, failure };
}

describe("extractFailureEvidence - retry-after", () => {
  it("reads an integer-seconds retry-after header into ms", () => {
    expect(
      extractFailureEvidence({ status: 429, headers: { "retry-after": "2" } }).retryAfterMs,
    ).toBe(2000);
  });

  it("reads a fetch Headers-like container via .get()", () => {
    const headers = new Map([["retry-after", "3"]]);
    expect(extractFailureEvidence({ headers }).retryAfterMs).toBe(3000);
  });

  it("reads a structured numeric retryAfterMs / retryAfter (seconds) field", () => {
    expect(extractFailureEvidence({ retryAfterMs: 1500 }).retryAfterMs).toBe(1500);
    expect(extractFailureEvidence({ retryAfter: 4 }).retryAfterMs).toBe(4000);
  });

  it("is undefined when no retry-after is present", () => {
    expect(extractFailureEvidence({ status: 500 }).retryAfterMs).toBeUndefined();
    expect(extractFailureEvidence("plain string error").retryAfterMs).toBeUndefined();
  });
});

describe("extractFailureEvidence - request id", () => {
  it("reads a top-level request_id", () => {
    expect(extractFailureEvidence({ status: 401, request_id: "req_abc123" }).requestId).toBe(
      "req_abc123",
    );
  });

  it("reads error.request_id and an x-request-id header", () => {
    expect(extractFailureEvidence({ error: { request_id: "req_nested" } }).requestId).toBe(
      "req_nested",
    );
    expect(extractFailureEvidence({ headers: { "x-request-id": "req_hdr" } }).requestId).toBe(
      "req_hdr",
    );
    expect(
      extractFailureEvidence({ headers: { "anthropic-request-id": "req_anth" } }).requestId,
    ).toBe("req_anth");
  });
});

describe("Codex / OpenAI OAuth shaped failures", () => {
  it("classifies a 401 auth error and preserves status + request id", () => {
    const cause = {
      status: 401,
      message: "401 Unauthorized: your authentication token has expired",
      request_id: "req_codex_1",
      error: { type: "invalid_request_error", code: "invalid_api_key" },
      headers: { "x-request-id": "req_codex_1" },
    };
    const { evidence, failure } = evidenceClass(cause);
    expect(failure.class).toBe("auth");
    expect(failure.retryable).toBe(false);
    expect(evidence.status).toBe(401);
    expect(evidence.requestId).toBe("req_codex_1");
    expect(evidence.code).toBe("invalid_api_key");
  });

  it("classifies a 429 rate limit and preserves retry-after for backoff diagnostics", () => {
    const cause = {
      status: 429,
      message: "Rate limit reached for gpt-5.5",
      headers: { "retry-after": "5", "x-request-id": "req_codex_2" },
    };
    const { evidence, failure } = evidenceClass(cause);
    expect(failure.class).toBe("rate_limited");
    expect(failure.retryable).toBe(true);
    expect(failure.retryAfterMs).toBe(5000);
    expect(evidence.retryAfterMs).toBe(5000);
    expect(evidence.requestId).toBe("req_codex_2");
  });
});

describe("Anthropic-like OAuth shaped failures", () => {
  it("classifies a 529 overloaded with an anthropic request id header", () => {
    const cause = {
      status: 529,
      message: "Overloaded",
      error: { type: "overloaded_error" },
      headers: { "anthropic-request-id": "req_xyz", "retry-after": "1" },
    };
    const { evidence, failure } = evidenceClass(cause);
    expect(failure.class).toBe("provider_overloaded");
    expect(failure.retryable).toBe(true);
    expect(evidence.status).toBe(529);
    expect(evidence.requestId).toBe("req_xyz");
    expect(evidence.code).toBe("overloaded_error");
    expect(evidence.retryAfterMs).toBe(1000);
  });

  it("classifies a 401 invalid bearer as auth (re-auth), not transport", () => {
    const cause = {
      status: 401,
      message: "authentication_error: invalid bearer token",
      error: { type: "authentication_error" },
    };
    const { failure } = evidenceClass(cause);
    expect(failure.class).toBe("auth");
    expect(failure.userAction).toBe("reauth");
  });
});

describe("Direct API-key shaped failures", () => {
  it("classifies an insufficient_quota code as quota/billing (terminal)", () => {
    const cause = {
      status: 429,
      message: "You exceeded your current quota",
      code: "insufficient_quota",
      error: { type: "insufficient_quota" },
    };
    const { evidence, failure } = evidenceClass(cause);
    // A hard quota that reports 429 must NOT be retried as a rate limit.
    expect(failure.class).toBe("quota_billing");
    expect(failure.retryable).toBe(false);
    expect(evidence.code).toBe("insufficient_quota");
  });

  it("classifies a 400 invalid request as request_rejected (terminal)", () => {
    const cause = { status: 400, message: "invalid request: bad params" };
    const { failure } = evidenceClass(cause);
    expect(failure.class).toBe("request_rejected");
    expect(failure.retryable).toBe(false);
  });
});

describe("Gateway shaped failures - origin attribution", () => {
  it("attributes an upstream provider failure with its provider name", () => {
    const cause = {
      status: 502,
      message: "Bad Gateway",
      error: {
        message: "upstream provider returned an error",
        metadata: { provider_name: "anthropic" },
      },
    };
    const { evidence, failure } = evidenceClass(cause, { gateway: true });
    expect(failure.class).toBe("provider_unavailable");
    expect(failure.retryable).toBe(true);
    expect(evidence.origin).toBe("upstream");
    expect(evidence.upstreamProvider).toBe("anthropic");
  });

  it("attributes a gateway-side failure as origin gateway when no upstream is named", () => {
    const cause = { status: 503, message: "gateway is temporarily unavailable" };
    const { evidence } = evidenceClass(cause, { gateway: true });
    expect(evidence.origin).toBe("gateway");
    expect(evidence.upstreamProvider).toBeUndefined();
  });

  it("infers upstream from an 'upstream' message even without metadata", () => {
    expect(
      extractFailureEvidence({ error: { message: "upstream connect error" } }, { gateway: true })
        .origin,
    ).toBe("upstream");
  });

  it("leaves origin undefined for a non-gateway source", () => {
    const cause = { status: 502, message: "Bad Gateway" };
    const evidence = extractFailureEvidence(cause);
    expect(evidence.origin).toBeUndefined();
  });
});

describe("Local runtime shaped failures - error class", () => {
  it("classifies an ECONNREFUSED for a local provider as runtime-unavailable and keeps the code", () => {
    const cause = {
      code: "ECONNREFUSED",
      message: "connect ECONNREFUSED 127.0.0.1:1234",
    };
    const { evidence, failure } = evidenceClass(cause, { local: true });
    expect(failure.class).toBe("local_runtime_unavailable");
    expect(failure.userAction).toBe("start_local_runtime");
    // The local runtime error CLASS is preserved as the SDK/transport code.
    expect(evidence.code).toBe("ECONNREFUSED");
    expect(evidence.status).toBeUndefined();
  });

  it("the SAME refusal from a cloud provider stays a retryable transport fault", () => {
    const cause = { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:1234" };
    const { failure } = evidenceClass(cause);
    expect(failure.class).toBe("transient_transport");
    expect(failure.retryable).toBe(true);
  });
});

describe("evidence shape fields and redaction safety", () => {
  it("records the top-level field NAMES of the raw error, sorted and capped, never values", () => {
    const cause = { status: 500, message: "boom", error: { type: "server_error" }, secret: "sk-x" };
    const evidence = extractFailureEvidence(cause);
    expect(evidence.shapeFields).toEqual(["error", "message", "secret", "status"]);
    // Field NAMES only - the secret VALUE never appears anywhere in the evidence.
    expect(JSON.stringify(evidence)).not.toContain("sk-x");
  });

  it("tolerates a plain string / non-object cause", () => {
    const evidence = extractFailureEvidence("connection reset by peer");
    expect(evidence.status).toBeUndefined();
    expect(evidence.code).toBeUndefined();
    expect(evidence.shapeFields).toBeUndefined();
  });
});

describe("02.15: nested-cause code recovery (APIConnectionError shape)", () => {
  it("recovers a syscall code from one `.cause` level down when the top has none", () => {
    const cause = {
      message: "Connection error.",
      cause: { code: "ECONNRESET", message: "read ECONNRESET" },
    };
    expect(extractFailureEvidence(cause).code).toBe("ECONNRESET");
  });

  it("descends two `.cause` levels (cause.cause.code)", () => {
    const cause = { message: "Connection error.", cause: { cause: { code: "ECONNRESET" } } };
    expect(extractFailureEvidence(cause).code).toBe("ECONNRESET");
  });

  it("recovers a numeric errno when no string code is present", () => {
    const cause = { message: "Connection error.", cause: { errno: -54 } };
    expect(extractFailureEvidence(cause).code).toBe("-54");
  });

  it("classification stays transient_transport/retryable, now with the structured code", () => {
    const cause = {
      message: "Connection error.",
      cause: { code: "ECONNRESET", message: "read ECONNRESET" },
    };
    const { evidence, failure } = evidenceClass(cause);
    expect(failure.class).toBe("transient_transport");
    expect(failure.retryable).toBe(true);
    expect(evidence.code).toBe("ECONNRESET"); // was undefined before the cause-chain descent
  });

  it("does not infinite-loop on a cyclic `.cause` chain", () => {
    const a: Record<string, unknown> = { message: "a" };
    const b: Record<string, unknown> = { message: "b", cause: a };
    a.cause = b; // cycle
    expect(() => extractFailureEvidence(a)).not.toThrow();
    expect(extractFailureEvidence(a).code).toBeUndefined();
  });
});

describe("02.15: causeChainDetail enrichment + redaction", () => {
  it("appends the nested syscall code so the banner shows the specific reason", () => {
    const cause = {
      message: "Connection error.",
      cause: { code: "ECONNRESET", message: "read ECONNRESET" },
    };
    expect(causeChainDetail("Connection error.", cause)).toBe("Connection error. (ECONNRESET)");
  });

  it("does not double-append when the code is already in the message", () => {
    const cause = { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:1234" };
    expect(causeChainDetail("connect ECONNREFUSED 127.0.0.1:1234", cause)).toBe(
      "connect ECONNREFUSED 127.0.0.1:1234",
    );
  });

  it("degrades cleanly: no cause, string cause, and plain message all return the top message", () => {
    expect(causeChainDetail("boom", { message: "boom" })).toBe("boom");
    expect(causeChainDetail("boom", "boom")).toBe("boom");
    expect(causeChainDetail("boom", undefined)).toBe("boom");
  });

  it("a secret-bearing detail is still redacted after enrichment (caller routes through redactSecrets)", () => {
    const cause = {
      message: "stream failed: Authorization: Bearer sk-secret123456789",
      cause: { code: "ECONNRESET" },
    };
    const enriched = causeChainDetail(
      "stream failed: Authorization: Bearer sk-secret123456789",
      cause,
    );
    const redacted = redactSecrets(enriched);
    expect(redacted).toContain("ECONNRESET"); // the specific reason survives
    expect(redacted).not.toContain("sk-secret123456789"); // the secret does not
  });
});
