import assert from "node:assert/strict";
import { test } from "vitest";
import { degraded, type LspDiagnostic } from "./contract";
import {
  describeDegraded,
  displayPath,
  formatDiagnosticLine,
  formatRange,
  formatSeverityCounts,
} from "./format";

/**
 * The shared LSP display formatting (plan 24 M3 REFACTOR task 7): one range/severity/source
 * rendering used by every lsp_* tool, so diagnostics, hover headers, symbols, and proposals
 * cannot drift apart in shape.
 */

function diagnostic(overrides: Partial<LspDiagnostic> = {}): LspDiagnostic {
  return {
    range: { start: { line: 3, column: 5 }, end: { line: 3, column: 9 } },
    severity: "warning",
    message: "oops",
    ...overrides,
  };
}

test("formatRange renders 1-based start-end, collapsing an empty range", () => {
  assert.equal(
    formatRange({ start: { line: 3, column: 5 }, end: { line: 4, column: 1 } }),
    "3:5-4:1",
  );
  assert.equal(formatRange({ start: { line: 3, column: 5 }, end: { line: 3, column: 5 } }), "3:5");
});

test("formatDiagnosticLine carries range, severity, source/code, and message", () => {
  assert.equal(
    formatDiagnosticLine(diagnostic({ source: "typescript", code: "2304", severity: "error" })),
    "3:5-3:9 error [typescript 2304] oops",
  );
  assert.equal(formatDiagnosticLine(diagnostic()), "3:5-3:9 warning oops");
});

test("formatSeverityCounts orders error > warning > info > hint and skips zeros", () => {
  const counts = formatSeverityCounts([
    diagnostic({ severity: "hint" }),
    diagnostic({ severity: "error" }),
    diagnostic({ severity: "error" }),
    diagnostic({ severity: "warning" }),
  ]);
  assert.equal(counts, "2 errors, 1 warning, 1 hint");
  assert.equal(formatSeverityCounts([]), "none");
});

test("describeDegraded renders a bounded single-line reason (D-006)", () => {
  assert.equal(
    describeDegraded(degraded("server_error", "the server crashed")),
    "language server error: the server crashed",
  );
  assert.equal(
    describeDegraded(degraded("timeout", "hover took too long")),
    "language server timed out: hover took too long",
  );
});

test("displayPath makes file uris and absolute paths workspace-relative when inside the root", () => {
  assert.equal(displayPath("file:///w/root/src/a.ts", "/w/root"), "src/a.ts");
  assert.equal(displayPath("/w/root/src/a.ts", "/w/root"), "src/a.ts");
  assert.equal(displayPath("/elsewhere/b.ts", "/w/root"), "/elsewhere/b.ts");
  assert.equal(displayPath("not-a-uri", "/w/root"), "not-a-uri");
});
