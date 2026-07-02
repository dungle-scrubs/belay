import assert from "node:assert/strict";
import { MAX_OUTPUT, TRUNCATION_NOTICE } from "@host/tools/shared";
import { test } from "vitest";
import {
  capItems,
  capText,
  MAX_LSP_CODE_ACTIONS,
  MAX_LSP_DEGRADED_DETAIL_CHARS,
  MAX_LSP_DIAGNOSTIC_MESSAGE_CHARS,
  MAX_LSP_DIAGNOSTICS,
  MAX_LSP_DOCUMENT_SYMBOLS,
  MAX_LSP_HOVER_CHARS,
  MAX_LSP_PROPOSAL_TEXT_CHARS,
  MAX_LSP_SERVER_LOG_CHARS,
  MAX_LSP_STORED_DIAGNOSTICS_PER_FILE,
  MAX_LSP_STORED_FILES,
  MAX_LSP_WORKSPACE_SYMBOLS,
} from "./caps";

/**
 * Plan 24 M1 tasks 5-6: every LSP payload cap exists, is a sane positive bound, and the cap
 * helpers actually cut - a tool result can never dump full-project data (D-006 boundedness).
 */

test("every list cap is positive and small enough to never dump a project", () => {
  const listCaps = [
    MAX_LSP_DIAGNOSTICS,
    MAX_LSP_STORED_DIAGNOSTICS_PER_FILE,
    MAX_LSP_STORED_FILES,
    MAX_LSP_DOCUMENT_SYMBOLS,
    MAX_LSP_WORKSPACE_SYMBOLS,
    MAX_LSP_CODE_ACTIONS,
  ];
  for (const cap of listCaps) {
    assert.ok(Number.isInteger(cap) && cap > 0, `list cap must be a positive integer: ${cap}`);
    assert.ok(cap <= 500, `list cap must stay bounded (<= 500): ${cap}`);
  }
});

test("every text cap fits inside the host's tool-output ceiling", () => {
  const textCaps = [
    MAX_LSP_DIAGNOSTIC_MESSAGE_CHARS,
    MAX_LSP_HOVER_CHARS,
    MAX_LSP_PROPOSAL_TEXT_CHARS,
    MAX_LSP_SERVER_LOG_CHARS,
    MAX_LSP_DEGRADED_DETAIL_CHARS,
  ];
  for (const cap of textCaps) {
    assert.ok(Number.isInteger(cap) && cap > 0, `text cap must be a positive integer: ${cap}`);
    assert.ok(cap <= MAX_OUTPUT, `text cap must fit the ${MAX_OUTPUT}-char tool ceiling: ${cap}`);
  }
});

test("capItems cuts a full-project-sized list to the cap and flags the cut", () => {
  const everyDiagnosticInTheRepo = Array.from({ length: 10_000 }, (_, index) => index);
  const capped = capItems(everyDiagnosticInTheRepo, MAX_LSP_DIAGNOSTICS);
  assert.equal(capped.items.length, MAX_LSP_DIAGNOSTICS);
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.items.slice(0, 3), [0, 1, 2], "keeps the head, in order");
});

test("capItems leaves a small list untouched", () => {
  const capped = capItems(["a", "b"], MAX_LSP_WORKSPACE_SYMBOLS);
  assert.deepEqual(capped.items, ["a", "b"]);
  assert.equal(capped.truncated, false);
});

test("capText cuts hover-sized markdown at the cap with the shared truncation marker", () => {
  const capped = capText("h".repeat(100_000), MAX_LSP_HOVER_CHARS);
  assert.equal(capped.text.length, MAX_LSP_HOVER_CHARS + TRUNCATION_NOTICE.length);
  assert.ok(capped.text.endsWith(TRUNCATION_NOTICE));
  assert.equal(capped.truncated, true);
});

test("capText leaves short text untouched", () => {
  const capped = capText("const x: number", MAX_LSP_HOVER_CHARS);
  assert.equal(capped.text, "const x: number");
  assert.equal(capped.truncated, false);
});
