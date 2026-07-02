import assert from "node:assert/strict";
import type { PreToolUseOutcome, StopOutcome } from "@host/hooks/runtime";
import { test } from "vitest";
import {
  preToolUseDecisionEvents,
  stopDecisionEvents,
  withHookDecisionEvents,
} from "./hook-events";
import type { TurnHooks } from "./loop";

/**
 * Plan 25 M9: the pure dispatch-outcome -> `hook.decision` event fold and the per-turn emitting
 * wrapper. Pins the emission policy: a plain allow is SILENT (log-only - one event per tool call
 * would drown the transcript), deny/halt/context/updated_input/continuation always emit,
 * diagnostics emit mapped to timeout/error/unapproved/trust_changed and are DEDUPED per turn
 * (an unapproved hook fires one row per turn, not one per tool call), and every wire reason is
 * redacted + bounded.
 */

const allow = (over: Partial<PreToolUseOutcome> = {}): PreToolUseOutcome => ({
  decision: "allow",
  contexts: [],
  diagnostics: [],
  ...over,
});

const stopAllow = (over: Partial<StopOutcome> = {}): StopOutcome => ({
  decision: "allow",
  contexts: [],
  diagnostics: [],
  ...over,
});

test("a plain allow emits nothing (allow is log-only, never a wire event)", () => {
  assert.deepEqual(preToolUseDecisionEvents("r-1", "bash", allow()), []);
  assert.deepEqual(stopDecisionEvents("r-1", stopAllow()), []);
});

test("a deny emits one hook.decision with the blocking hook, tool, and bounded reason", () => {
  const events = preToolUseDecisionEvents(
    "r-1",
    "bash",
    allow({ decision: "deny", hook: "project:guard", reason: "workspace is read-only" }),
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "hook.decision",
    payload: {
      runId: "r-1",
      hookId: "project:guard",
      event: "PreToolUse",
      decision: "deny",
      toolName: "bash",
      reason: "workspace is read-only",
    },
  });
});

test("a halt emits, and context notes gathered before the block ride as context events", () => {
  const events = preToolUseDecisionEvents(
    "r-1",
    "write",
    allow({
      decision: "halt",
      hook: "project:gate",
      reason: "stop everything",
      contexts: [{ hook: "project:note", context: "heads up" }],
    }),
  );
  assert.deepEqual(
    events.map((e) => [e.payload.decision, e.payload.hookId]),
    [
      ["context", "project:note"],
      ["halt", "project:gate"],
    ],
  );
  assert.equal(events[0]?.payload.reason, "heads up");
});

test("an applied input rewrite emits one updated_input event per contributing hook", () => {
  const events = preToolUseDecisionEvents(
    "r-1",
    "bash",
    allow({
      updatedInput: { command: "echo safe" },
      updatedInputHooks: ["project:first", "user:second"],
    }),
  );
  assert.deepEqual(
    events.map((e) => [e.payload.decision, e.payload.hookId, e.payload.toolName]),
    [
      ["updated_input", "project:first", "bash"],
      ["updated_input", "user:second", "bash"],
    ],
  );
});

test("diagnostics map to their wire verbs: timeout/unapproved/trust_changed keep their names, the rest are errors", () => {
  const events = preToolUseDecisionEvents(
    "r-1",
    "bash",
    allow({
      diagnostics: [
        { hook: "project:slow", reason: "timeout", detail: "hook timed out after 5000ms" },
        { hook: "project:new", reason: "unapproved", detail: "hook is not approved" },
        { hook: "user:edited", reason: "trust_changed", detail: "config changed since approval" },
        { hook: "project:broken", reason: "command_failed", detail: "exited with code 1" },
        { hook: "project:garbled", reason: "invalid_json", detail: "stdout is not JSON" },
        { hook: "project:gone", reason: "missing_script", detail: "script does not exist" },
        { hook: "project:sneaky", reason: "updated_input_rejected", detail: "cwd not allowlisted" },
      ],
    }),
  );
  assert.deepEqual(
    events.map((e) => [e.payload.decision, e.payload.hookId]),
    [
      ["timeout", "project:slow"],
      ["unapproved", "project:new"],
      ["trust_changed", "user:edited"],
      ["error", "project:broken"],
      ["error", "project:garbled"],
      ["error", "project:gone"],
      ["error", "project:sneaky"],
    ],
  );
  // The wire reason keeps the machine tag ahead of the redacted detail.
  assert.equal(events[3]?.payload.reason, "command_failed: exited with code 1");
});

test("a wire reason is redacted and bounded to one line", () => {
  const events = preToolUseDecisionEvents(
    "r-1",
    "bash",
    allow({
      decision: "deny",
      hook: "project:guard",
      reason: `token=sk-abc123secret ${"x".repeat(500)}`,
    }),
  );
  const reason = String(events[0]?.payload.reason);
  assert.ok(!reason.includes("sk-abc123secret"), "secrets are redacted");
  assert.ok(reason.length <= 220, `bounded, got ${reason.length}`);
});

test("a Stop halt emits one halt event; its dead context notes do not", () => {
  const events = stopDecisionEvents(
    "r-1",
    stopAllow({
      decision: "halt",
      hook: "project:review",
      reason: "cover the edge case",
      contexts: [{ hook: "project:other", context: "unused note" }],
    }),
  );
  assert.deepEqual(
    events.map((e) => [e.payload.decision, e.payload.hookId, e.payload.event]),
    [["halt", "project:review", "Stop"]],
  );
});

test("a Stop continuation request emits one continuation event per asking hook", () => {
  const events = stopDecisionEvents(
    "r-1",
    stopAllow({ contexts: [{ hook: "project:review", context: "also cover the tests" }] }),
  );
  assert.deepEqual(
    events.map((e) => [e.payload.decision, e.payload.hookId]),
    [["continuation", "project:review"]],
  );
  assert.equal(events[0]?.payload.reason, "also cover the tests");
});

test("an exhausted second continuation ask emits only its diagnostic, never a continuation", () => {
  const events = stopDecisionEvents(
    "r-1",
    stopAllow({
      contexts: [{ hook: "project:review", context: "one more pass" }],
      diagnostics: [
        {
          hook: "project:review",
          reason: "continuation_exhausted",
          detail: "the one continuation pass for this run is spent",
        },
      ],
    }),
  );
  assert.deepEqual(
    events.map((e) => e.payload.decision),
    ["error"],
  );
});

test("withHookDecisionEvents dedupes DIAGNOSTIC events per turn but never blocking/context ones", () => {
  const published: string[] = [];
  const seen: string[] = [];
  const hooks: TurnHooks = {
    dispatchPreToolUse: () => Promise.reject(new Error("unused")),
    sessionId: "s",
    callerKind: "main",
    cwd: "/w",
    onOutcome: (report) => seen.push(report.toolName),
  };
  const wrapped = withHookDecisionEvents(hooks, "r-1", (event) =>
    published.push(`${event.payload.decision}:${event.payload.hookId}`),
  );

  const unapprovedDeny = allow({
    decision: "deny",
    hook: "project:guard",
    diagnostics: [{ hook: "project:new", reason: "unapproved", detail: "not approved" }],
  });
  wrapped.onOutcome?.({ callId: "c1", toolName: "bash", outcome: unapprovedDeny });
  wrapped.onOutcome?.({ callId: "c2", toolName: "read", outcome: unapprovedDeny });

  // The unapproved diagnostic emits once for the turn; each deny (a real per-call block) emits.
  assert.deepEqual(published, [
    "deny:project:guard",
    "unapproved:project:new",
    "deny:project:guard",
  ]);
  // The wrapped observer still composes with the caller's own onOutcome seam.
  assert.deepEqual(seen, ["bash", "read"]);
});
