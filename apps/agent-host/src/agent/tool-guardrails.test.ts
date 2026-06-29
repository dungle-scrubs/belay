import assert from "node:assert/strict";
import { test } from "vitest";
import {
  argsFingerprint,
  createToolGuardrails,
  isFailureResult,
  resultFingerprint,
} from "./tool-guardrails";

/**
 * Plan 07 (tool-call guardrails): the pure per-turn controller observes tool calls + results,
 * tracks redacted fingerprints and counters, and returns typed decisions. It executes nothing,
 * mutates no history, publishes no events, and stores no raw arguments or raw output (D-002,
 * D-005). These unit tests pin the fingerprint helpers and the per-turn state shape (M1).
 */

const readOnly = new Set(["read", "grep", "glob"]);

test("M1: argsFingerprint is stable under key order (sorted canonical JSON)", () => {
  const a = argsFingerprint(JSON.stringify({ path: "a.ts", limit: 5, offset: 0 }));
  const b = argsFingerprint(JSON.stringify({ offset: 0, limit: 5, path: "a.ts" }));
  assert.equal(a, b, "the same object hashes identically regardless of key order");

  const nested1 = argsFingerprint(JSON.stringify({ q: "x", opts: { b: 2, a: 1 } }));
  const nested2 = argsFingerprint(JSON.stringify({ opts: { a: 1, b: 2 }, q: "x" }));
  assert.equal(nested1, nested2, "nested object keys are sorted recursively");
});

test("M1: argsFingerprint distinguishes different arguments", () => {
  const a = argsFingerprint(JSON.stringify({ path: "a.ts" }));
  const b = argsFingerprint(JSON.stringify({ path: "b.ts" }));
  assert.notEqual(a, b);
});

test("M1: argsFingerprint falls back to a stable hash for non-object / non-JSON input", () => {
  // A bare non-JSON string still fingerprints deterministically (never throws).
  const raw1 = argsFingerprint("not json at all");
  const raw2 = argsFingerprint("not json at all");
  assert.equal(raw1, raw2, "the same raw string hashes identically");
  assert.notEqual(raw1, argsFingerprint("a different raw string"));
  // An empty argument string is treated as an empty object, never a throw.
  assert.equal(argsFingerprint(""), argsFingerprint("{}"));
  // A JSON scalar (non-object) is hashed by value, stably.
  assert.equal(argsFingerprint("42"), argsFingerprint("42"));
});

test("M1: a fingerprint is a short hex digest, not the raw value", () => {
  const fp = argsFingerprint(JSON.stringify({ path: "/secret/path.ts" }));
  assert.match(fp, /^[0-9a-f]{12}$/, "short hex digest");
  assert.doesNotMatch(fp, /secret/, "the raw value never appears in the fingerprint");

  const rfp = resultFingerprint("the quick brown fox jumped over the lazy dog");
  assert.match(rfp, /^[0-9a-f]{12}$/);
  assert.doesNotMatch(rfp, /brown fox/);
});

test("M1: state stores only fingerprints and counters, never raw args or raw output", () => {
  const guardrails = createToolGuardrails({ readOnly });
  const secretArgs = JSON.stringify({ path: "/etc/passwd", token: "sk-LIVE-123" });
  const secretResult = "root:x:0:0:root:/root:/bin/bash";
  guardrails.observe("read", secretArgs, secretResult);

  const dump = JSON.stringify(guardrails.snapshot());
  assert.doesNotMatch(dump, /passwd/, "raw argument values are not retained");
  assert.doesNotMatch(dump, /sk-LIVE-123/, "raw secret tokens are not retained");
  assert.doesNotMatch(dump, /root:x:0/, "raw output is not retained");

  const entry = guardrails.snapshot()[0];
  assert.equal(entry?.tool, "read");
  assert.equal(entry?.calls, 1, "the per-signature call counter advanced");
  assert.match(entry?.argsFingerprint ?? "", /^[0-9a-f]{12}$/);
});

test("M1: state is keyed by tool name plus args fingerprint", () => {
  const guardrails = createToolGuardrails({ readOnly });
  guardrails.observe("read", JSON.stringify({ path: "a.ts" }), "A");
  guardrails.observe("read", JSON.stringify({ path: "a.ts" }), "A again");
  guardrails.observe("read", JSON.stringify({ path: "b.ts" }), "B");
  guardrails.observe("grep", JSON.stringify({ path: "a.ts" }), "G");

  const entries = guardrails.snapshot();
  assert.equal(entries.length, 3, "three distinct (tool, args) signatures");
  const sameArgs = entries.find((e) => e.tool === "read" && e.calls === 2);
  assert.ok(sameArgs, "two reads with identical args share one signature with calls=2");
});

test("M1: an observation of an allow-only call returns the allow decision with redacted fields", () => {
  const guardrails = createToolGuardrails({ readOnly });
  const decision = guardrails.observe("read", JSON.stringify({ path: "a.ts" }), "contents");
  assert.equal(decision.action, "allow");
  assert.equal(decision.tool, "read");
  assert.match(decision.argsFingerprint, /^[0-9a-f]{12}$/);
  assert.equal(decision.guidance, undefined, "an allow decision carries no model guidance");
});

// --- M2: failure tracking ---

const ARGS = JSON.stringify({ path: "a.ts" });
const FAIL = 'error: read failed - file "a.ts" not found';

test("M2: a repeated exact failure warns only after the configured threshold", () => {
  const guardrails = createToolGuardrails({ readOnly, config: { failureWarnAt: 3 } });
  assert.equal(guardrails.observe("read", ARGS, FAIL).action, "allow", "first failure is advisory");
  assert.equal(guardrails.observe("read", ARGS, FAIL).action, "allow", "second still advisory");
  const third = guardrails.observe("read", ARGS, FAIL);
  assert.equal(third.action, "warn", "the third identical failure warns");
  assert.equal(third.reason, "repeated_failure");
  assert.equal(third.count, 3);
  assert.match(third.failureFingerprint ?? "", /^[0-9a-f]{12}$/);
  assert.equal(
    third.resultFingerprint,
    undefined,
    "a failure decision carries no result fingerprint",
  );
  assert.match(third.guidance ?? "", /failed 3 times/i, "guidance names the failure streak");
});

test("M2: a same-args success clears the prior exact-failure state (D-001)", () => {
  const guardrails = createToolGuardrails({ readOnly, config: { failureWarnAt: 3 } });
  guardrails.observe("read", ARGS, FAIL);
  guardrails.observe("read", ARGS, FAIL); // failure streak is now 2
  const recovered = guardrails.observe("read", ARGS, "the file contents");
  assert.equal(recovered.action, "allow", "a success is never a failure warning");
  // The streak was cleared: a fresh failure starts over at 1, so the next two stay advisory.
  assert.equal(guardrails.observe("read", ARGS, FAIL).action, "allow", "streak reset to 1");
  assert.equal(guardrails.observe("read", ARGS, FAIL).action, "allow", "still only 2 after reset");
  assert.equal(guardrails.observe("read", ARGS, FAIL).action, "warn", "warns again at 3");
});

test("M2: failure pressure is tracked per signature, not pooled across the same tool", () => {
  const guardrails = createToolGuardrails({ readOnly, config: { failureWarnAt: 3 } });
  const argsA = JSON.stringify({ path: "a.ts" });
  const argsB = JSON.stringify({ path: "b.ts" });
  guardrails.observe("read", argsA, "error: a failed");
  guardrails.observe("read", argsA, "error: a failed");
  // A different-args failure must NOT inherit A's streak - it starts its own count.
  const b = guardrails.observe("read", argsB, "error: b failed");
  assert.equal(b.action, "allow", "broader same-tool failure pressure stays advisory");
  assert.equal(b.count, 1, "the new signature's failure streak starts at 1");
});

test("M2: a differing exact-failure message resets the streak (only an EXACT repeat accumulates)", () => {
  const guardrails = createToolGuardrails({ readOnly, config: { failureWarnAt: 3 } });
  guardrails.observe("read", ARGS, "error: transient timeout");
  guardrails.observe("read", ARGS, "error: transient timeout");
  // A different failure reason for the same args is not the SAME exact failure: the streak resets.
  const changed = guardrails.observe("read", ARGS, "error: permission denied");
  assert.equal(changed.action, "allow");
  assert.equal(changed.count, 1, "a changed failure message restarts the streak");
});

test("M2: failure classification reads the local `error:` convention, not transcript prose", () => {
  assert.equal(isFailureResult("error: read failed - no such file"), true);
  assert.equal(isFailureResult("  error: leading whitespace still counts"), true);
  assert.equal(
    isFailureResult("The build had 3 errors but the tool succeeded"),
    false,
    "the word error mid-text is not a tool failure",
  );
  // A success whose body merely mentions "error" never accumulates a failure streak.
  const guardrails = createToolGuardrails({ readOnly, config: { failureWarnAt: 2 } });
  guardrails.observe("grep", ARGS, "match: throw new Error('boom')");
  const second = guardrails.observe("grep", ARGS, "match: throw new Error('boom')");
  assert.notEqual(second.reason, "repeated_failure", "prose mentioning error is not a failure");
});

// --- M3: read-only no-progress tracking ---

test("M3: a read-only same-args same-result run warns after the threshold", () => {
  const guardrails = createToolGuardrails({ readOnly, config: { noProgressWarnAt: 3 } });
  const out = "the same file contents";
  assert.equal(guardrails.observe("read", ARGS, out).action, "allow");
  assert.equal(guardrails.observe("read", ARGS, out).action, "allow");
  const third = guardrails.observe("read", ARGS, out);
  assert.equal(third.action, "warn");
  assert.equal(third.reason, "no_progress");
  assert.equal(third.count, 3);
  assert.match(third.resultFingerprint ?? "", /^[0-9a-f]{12}$/);
  assert.equal(third.failureFingerprint, undefined);
  assert.match(third.guidance ?? "", /identical result 3 times/i);
});

test("M3: same args with DIFFERENT results never counts as no progress (D-004)", () => {
  const guardrails = createToolGuardrails({ readOnly, config: { noProgressWarnAt: 3 } });
  // A read-only tool whose output genuinely changes each call (a clock-like / dynamic read).
  for (let i = 0; i < 6; i += 1) {
    const decision = guardrails.observe("read", ARGS, `tick ${i}`);
    assert.equal(decision.action, "allow", `changing results never warn (call ${i})`);
  }
});

test("M3: a changed result resets the same-result streak", () => {
  const guardrails = createToolGuardrails({ readOnly, config: { noProgressWarnAt: 3 } });
  guardrails.observe("read", ARGS, "A");
  guardrails.observe("read", ARGS, "A"); // sameResults = 2
  const changed = guardrails.observe("read", ARGS, "B");
  assert.equal(changed.count, 1, "a new result fingerprint restarts the streak");
  assert.equal(changed.action, "allow");
  // Two more identical "B" results bring the streak back to the warn threshold.
  guardrails.observe("read", ARGS, "B");
  assert.equal(guardrails.observe("read", ARGS, "B").action, "warn");
});

test("M3: dynamic / mutating tools are excluded from same-result detection (D-006)", () => {
  const guardrails = createToolGuardrails({ readOnly, config: { noProgressWarnAt: 3 } });
  for (const tool of ["bash", "write", "edit", "multi_edit", "process", "task_create"]) {
    let last = { action: "allow" } as { action: string };
    for (let i = 0; i < 6; i += 1) {
      last = guardrails.observe(tool, ARGS, "identical output every time");
    }
    assert.equal(last.action, "allow", `${tool} never trips no-progress on identical output`);
  }
  // None of those tools accumulated a same-result streak in state.
  for (const entry of guardrails.snapshot()) {
    assert.equal(entry.sameResults, 0, `${entry.tool} keeps no same-result streak`);
    assert.equal(entry.lastResultFingerprint, undefined);
  }
});

test("M3: read-only purity comes from the injected registry set, not a hardcoded name list", () => {
  // `search` is marked read-only here and participates; `custom_dyn` is not and is excluded - the
  // classification follows the injected set (the registry-derived source of truth, D-006).
  const guardrails = createToolGuardrails({
    readOnly: new Set(["search"]),
    config: { noProgressWarnAt: 2 },
  });
  guardrails.observe("search", ARGS, "same");
  assert.equal(guardrails.observe("search", ARGS, "same").action, "warn", "a read-only tool warns");

  guardrails.observe("custom_dyn", ARGS, "same");
  assert.equal(
    guardrails.observe("custom_dyn", ARGS, "same").action,
    "allow",
    "a tool absent from the set is dynamic and excluded",
  );
});

test("M3: a read-only call's args fingerprint round-trips the canonical helper", () => {
  const guardrails = createToolGuardrails({ readOnly });
  const decision = guardrails.observe("read", JSON.stringify({ limit: 5, path: "a.ts" }), "x");
  assert.equal(
    decision.argsFingerprint,
    argsFingerprint(JSON.stringify({ path: "a.ts", limit: 5 })),
    "the decision's fingerprint matches the exported canonical helper",
  );
  assert.notEqual(decision.resultFingerprint, undefined);
  assert.equal(decision.resultFingerprint, resultFingerprint("x"));
});

// --- M6: optional hard stops ---

test("M6: hard stops are disabled by default - a repeating path only ever warns", () => {
  const guardrails = createToolGuardrails({ readOnly }); // default config: hardStop off
  let last = guardrails.observe("read", ARGS, FAIL);
  for (let i = 0; i < 9; i += 1) {
    last = guardrails.observe("read", ARGS, FAIL);
  }
  assert.equal(last.action, "warn", "without hardStop, even a long failure streak never blocks");

  const readOnlyGuard = createToolGuardrails({ readOnly });
  let lastRead = readOnlyGuard.observe("read", ARGS, "same");
  for (let i = 0; i < 9; i += 1) {
    lastRead = readOnlyGuard.observe("read", ARGS, "same");
  }
  assert.equal(lastRead.action, "warn", "without hardStop, no-progress never blocks either");
});

test("M6: an enabled hard stop blocks once the failure threshold is met", () => {
  const guardrails = createToolGuardrails({
    readOnly,
    config: { failureWarnAt: 3, hardStop: true, hardStopAt: 5 },
  });
  const actions = Array.from({ length: 5 }, () => guardrails.observe("read", ARGS, FAIL).action);
  assert.deepEqual(
    actions,
    ["allow", "allow", "warn", "warn", "block"],
    "warn first, then block at 5",
  );
  const block = guardrails.observe("read", ARGS, FAIL);
  assert.equal(block.action, "block");
  assert.equal(block.reason, "repeated_failure");
  assert.match(
    block.guidance ?? "",
    /withheld/i,
    "the block guidance frames the output as withheld",
  );
});

test("M6: a hard stop requires an UNINTERRUPTED streak - an intervening success resets it", () => {
  const guardrails = createToolGuardrails({
    readOnly,
    config: { failureWarnAt: 3, hardStop: true, hardStopAt: 5 },
  });
  for (let i = 0; i < 4; i += 1) {
    guardrails.observe("read", ARGS, FAIL); // streak climbs to 4 (one short of block)
  }
  guardrails.observe("read", ARGS, "recovered output"); // a success clears the streak
  const actions = Array.from({ length: 5 }, () => guardrails.observe("read", ARGS, FAIL).action);
  assert.deepEqual(
    actions,
    ["allow", "allow", "warn", "warn", "block"],
    "the post-success streak starts over - block needs 5 fresh consecutive failures",
  );
});

test("M6: a no-progress hard stop requires the SAME result with no intervening change", () => {
  const guardrails = createToolGuardrails({
    readOnly,
    config: { noProgressWarnAt: 3, hardStop: true, hardStopAt: 5 },
  });
  for (let i = 0; i < 4; i += 1) {
    guardrails.observe("read", ARGS, "same"); // same-result streak climbs to 4
  }
  guardrails.observe("read", ARGS, "DIFFERENT"); // a changed result resets it
  const actions = Array.from({ length: 5 }, () => guardrails.observe("read", ARGS, "same").action);
  assert.deepEqual(
    actions,
    ["allow", "allow", "warn", "warn", "block"],
    "a changed result restarts the streak; block needs 5 fresh identical results",
  );
});
