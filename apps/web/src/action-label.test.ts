import assert from "node:assert/strict";
import { test } from "vitest";
import {
  compactionActionLabel,
  FALLBACK_ACTION_LABEL,
  RECOVERY_ACTION_LABEL,
  reconnectActionLabel,
  redactLabelFragment,
  toolActionLabel,
  toolActionLabelForTarget,
  turnActionLabel,
} from "./action-label";

/**
 * Plan 31 M2/M3: deterministic action-label projection. Every label is derived from structured
 * fields (turn phase, tool name/args) - never fuzzy prose - and a missing-evidence case always
 * falls back to the generic label rather than guessing, going blank, or throwing.
 */

// --- turn-level labels ---

test("turn: cold start reports the loading model", () => {
  assert.equal(turnActionLabel({ warm: false, model: "qwen", streaming: false }), "loading qwen");
});

test("turn: warm + silent is thinking", () => {
  assert.equal(turnActionLabel({ warm: true, model: "qwen", streaming: false }), "thinking");
});

test("turn: warm + produced text is streaming", () => {
  assert.equal(turnActionLabel({ warm: true, model: "qwen", streaming: true }), "streaming");
});

test("turn: steering overrides the phase", () => {
  assert.equal(
    turnActionLabel({ warm: true, model: "qwen", streaming: true, steering: true }),
    "applying steering",
  );
});

test("turn: no model on a cold start falls back rather than 'loading '", () => {
  assert.equal(
    turnActionLabel({ warm: false, model: "", streaming: false }),
    FALLBACK_ACTION_LABEL,
  );
});

// --- tool labels ---

test("tool: read shows the path", () => {
  assert.equal(
    toolActionLabel("read", JSON.stringify({ path: "apps/web/src/app.tsx" })),
    "reading apps/web/src/app.tsx",
  );
});

test("tool: grep shows the pattern", () => {
  assert.equal(
    toolActionLabel("grep", JSON.stringify({ pattern: "useSlashMenu" })),
    "searching useSlashMenu",
  );
});

test("tool: glob finds files by pattern", () => {
  const label = toolActionLabel("glob", JSON.stringify({ pattern: "src/**/*.ts" }));
  assert.match(label, /src\/\*\*\/\*\.ts/);
});

test("tool: bash shows the command", () => {
  assert.equal(
    toolActionLabel("bash", JSON.stringify({ command: "pnpm test" })),
    "running pnpm test",
  );
});

test("tool: write / edit / multi_edit target the path", () => {
  assert.equal(
    toolActionLabel("write", JSON.stringify({ path: "index.css" })),
    "writing index.css",
  );
  assert.equal(toolActionLabel("edit", JSON.stringify({ path: "index.css" })), "editing index.css");
  assert.equal(
    toolActionLabel("multi_edit", JSON.stringify({ path: "index.css" })),
    "editing index.css",
  );
});

test("tool: web_search / docs / archive have present-progress verbs", () => {
  assert.equal(
    toolActionLabel("web_search", JSON.stringify({ query: "vitest" })),
    "searching the web vitest",
  );
  assert.equal(
    toolActionLabel("docs", JSON.stringify({ subject: "effect" })),
    "looking up docs effect",
  );
  assert.equal(toolActionLabel("archive_read", JSON.stringify({})), "reading archive");
  // The real second archive tool name is "archive_unpack" (see packages/session/src/tools.ts) -
  // a fixture of "archive_write" would only pass via the loose `startsWith("archive")` prefix
  // match, giving false confidence that the real tool name is exercised.
  assert.equal(toolActionLabel("archive_unpack", JSON.stringify({})), "extracting archive");
});

test("tool: skill / process get running-verb labels", () => {
  assert.match(toolActionLabel("skill", JSON.stringify({ path: "planner" })), /skill/);
  assert.match(toolActionLabel("process", JSON.stringify({})), /process/);
});

test("tool: unknown tool names itself and never leaks raw JSON args", () => {
  const label = toolActionLabel("frobnicate", JSON.stringify({ secret: "hunter2", n: 3 }));
  assert.equal(label, "running frobnicate");
  assert.doesNotMatch(label, /hunter2/);
});

test("tool: no args yields the verb alone (never blank)", () => {
  assert.equal(toolActionLabel("read"), "reading");
  assert.equal(toolActionLabel(""), FALLBACK_ACTION_LABEL);
});

test("tool: an unknown tool's own NAME is redacted before interpolation, not just its args", () => {
  const longName = `bad${"x".repeat(100)}tool`;
  const label = toolActionLabel(longName, JSON.stringify({}));
  assert.doesNotMatch(label, /\n/);
  assert.ok(label.length <= 48 + "running ".length);
  assert.match(label, /^running /);
  assert.match(label, /…$/);

  const newlineName = "weird\ntool\nname";
  const label2 = toolActionLabel(newlineName, JSON.stringify({}));
  assert.doesNotMatch(label2, /\n/);
  assert.equal(label2, "running weird tool name");
});

// --- toolActionLabelForTarget: the lighter-weight sibling used by production renderers that
// already have their own typed target string (query/url/path) rather than raw args JSON ---

test("toolActionLabelForTarget: known tools compose verb + the caller's own target string", () => {
  assert.equal(
    toolActionLabelForTarget("web_search", "useSlashMenu"),
    "searching the web useSlashMenu",
  );
  assert.equal(
    toolActionLabelForTarget("web_fetch", "https://example.com/x"),
    "fetching https://example.com/x",
  );
  assert.equal(
    toolActionLabelForTarget("session_recall", "prior decision"),
    "recalling prior decision",
  );
  assert.equal(toolActionLabelForTarget("docs", "Effect Schema"), "looking up docs Effect Schema");
});

test("toolActionLabelForTarget: no target yields the verb alone; unknown tool still redacts", () => {
  assert.equal(toolActionLabelForTarget("web_search"), "searching the web");
  assert.equal(toolActionLabelForTarget("frobnicate", "secret stuff"), "running frobnicate");
});

// --- toolSummary leak: the salient-field fallback must never leak sibling raw args (M2 fix) ---

test("toolActionLabel: a write call missing `path` never leaks its `content` into the label", () => {
  const label = toolActionLabel(
    "write",
    JSON.stringify({ content: "SECRET_API_KEY=hunter2\nDB_PASSWORD=swordfish" }),
  );
  assert.equal(label, "writing");
  assert.doesNotMatch(label, /SECRET_API_KEY/);
  assert.doesNotMatch(label, /hunter2/);
});

test("toolActionLabel: an edit call missing `path` never leaks `old`/`new` into the label", () => {
  const label = toolActionLabel(
    "edit",
    JSON.stringify({ old: "const token = 'abc123';", new: "const token = 'xyz789';" }),
  );
  assert.equal(label, "editing");
  assert.doesNotMatch(label, /abc123|xyz789/);
});

// --- redaction / truncation ---

test("redact: collapses newlines to a single line", () => {
  assert.equal(redactLabelFragment("line one\nline two\t  end"), "line one line two end");
});

test("redact: truncates long fragments with an ellipsis", () => {
  const label = redactLabelFragment("x".repeat(200), 48);
  assert.ok(label.length <= 48);
  assert.match(label, /…$/);
});

test("tool: a multiline bash command never leaks a newline into the label", () => {
  const label = toolActionLabel(
    "bash",
    JSON.stringify({ command: "echo a\nrm -rf /tmp/x\necho b" }),
  );
  assert.doesNotMatch(label, /\n/);
  assert.match(label, /^running /);
});

// --- reconnect / recovery / compaction ---

test("reconnect: structured attempt label", () => {
  assert.equal(reconnectActionLabel(2, 5), "reconnecting (attempt 2/5)");
});

test("recovery + compaction: short present-progress labels, single line, no punctuation blowup", () => {
  for (const label of [RECOVERY_ACTION_LABEL, compactionActionLabel()]) {
    assert.doesNotMatch(label, /\n/);
    assert.ok(label.length <= 48);
    assert.ok(label.length > 0);
  }
});
