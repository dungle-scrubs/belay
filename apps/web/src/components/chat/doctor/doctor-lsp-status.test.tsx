import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import type { DoctorFinding } from "@trevor/session";
import { test } from "vitest";
import { DoctorAreaRow } from "./doctor-area-row";
import {
  lspDiagnosticWarning,
  lspError,
  lspMissing,
  lspOk,
  lspTimeout,
  lspUnconfigured,
} from "./doctor-fixtures";

/**
 * Plan 24 M8: the LSP status states rendered through the generic doctor peripheral mapping.
 * The fixtures mirror the HOST's real LSP area shape (doctor/lsp-status fold -> peripheralArea,
 * plus the diagnostic-warning finding), so these pin what the browser actually shows per state:
 * the ready server/freshness detail, the missing-binary install hint, the sanitized crash
 * detail, the init-timeout retry hint, and the stored-diagnostics warning with its pull action -
 * and that no fixture carries a raw home path or an env value (M8 redaction).
 */

const LSP_AREAS = [
  lspOk,
  lspUnconfigured,
  lspMissing,
  lspError,
  lspTimeout,
  lspDiagnosticWarning,
] as const;

test("the ready LSP row shows the server name and freshness", () => {
  const { container } = render(<DoctorAreaRow area={lspOk} />);
  const text = container.textContent ?? "";
  assert.ok(text.includes("typescript-language-server"), "server name");
  assert.ok(text.includes("ready"), "state word");
  assert.ok(text.includes("checked 2m ago"), "freshness / last checked");
});

test("the unconfigured LSP row is a quiet not-checked line, not an error", () => {
  const { container } = render(<DoctorAreaRow area={lspUnconfigured} />);
  assert.equal(lspUnconfigured.status, "not_checked");
  assert.ok((container.textContent ?? "").includes("LSP is not configured."));
});

test("a missing binary warns with the lookup locations, the install hint, and a repair action", () => {
  let clicked: DoctorFinding | null = null;
  const { container, getByRole } = render(
    <DoctorAreaRow area={lspMissing} onAction={(finding) => (clicked = finding)} />,
  );
  const text = container.textContent ?? "";
  assert.equal(lspMissing.status, "warn");
  assert.ok(text.includes("not installed"), text);
  assert.ok(text.includes("node_modules/.bin and PATH"), "the lookup locations are named");
  assert.ok(text.includes("pnpm add -g typescript-language-server"), "the install hint");
  fireEvent.click(getByRole("button", { name: "Check the LSP integration" }));
  assert.equal((clicked as DoctorFinding | null)?.id, "lsp.status");
});

test("a crashed server renders as an error with its sanitized crash detail", () => {
  const { container } = render(<DoctorAreaRow area={lspError} />);
  const text = container.textContent ?? "";
  assert.equal(lspError.status, "error");
  assert.ok(text.includes("code 1"), "the sanitized exit detail is visible");
  assert.ok(text.includes("Inspect the LSP integration"), "the inspect action is offered");
});

test("an initialize timeout renders as not-checked with a retry hint on expand", () => {
  const { container, getByRole } = render(<DoctorAreaRow area={lspTimeout} />);
  assert.equal(lspTimeout.status, "not_checked");
  assert.ok((container.textContent ?? "").includes("timed out after 10000ms"));
  // not_checked is a quiet state, so the retry action rests collapsed behind the row expander.
  fireEvent.click(getByRole("button", { name: /lsp area details/i }));
  assert.ok((container.textContent ?? "").includes("Re-run /doctor to retry"));
});

test("stored diagnostics with errors warn with bounded counts and the pull action", () => {
  let clicked: DoctorFinding | null = null;
  const { container, getByRole } = render(
    <DoctorAreaRow area={lspDiagnosticWarning} onAction={(finding) => (clicked = finding)} />,
  );
  const text = container.textContent ?? "";
  assert.equal(lspDiagnosticWarning.status, "warn");
  assert.ok(text.includes("2 errors, 1 warning in 2 files"), "bounded counts, never messages");
  fireEvent.click(getByRole("button", { name: "Pull details with lsp_diagnostics" }));
  assert.equal((clicked as DoctorFinding | null)?.id, "lsp.diagnostics");
});

test("no LSP fixture leaks a raw home path or an env value (M8 redaction)", () => {
  for (const area of LSP_AREAS) {
    const raw = JSON.stringify(area);
    assert.doesNotMatch(raw, /\/Users\/|\/home\//, `${area.verdict} must abbreviate home paths`);
    assert.doesNotMatch(raw, /token=|bearer|api[-_]?key/i, `${area.verdict} must carry no secret`);
  }
});
