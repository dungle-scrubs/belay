import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import type { DoctorFinding } from "@trevor/session";
import { test } from "vitest";
import { DoctorAreaRow } from "./doctor-area-row";
import { mcpAuthNeeded, mcpError, mcpOk, mcpTimeout, mcpUnconfigured } from "./doctor-fixtures";

/**
 * Plan 23 M8: the MCP status states rendered through the generic doctor peripheral mapping.
 * The fixtures mirror the HOST's real MCP area shape (doctor/mcp-status fold -> peripheralArea),
 * so these pin what the browser actually shows per state: the ready counts/freshness detail, an
 * always-visible auth/error finding with its next action, the timeout retry hint - and that no
 * fixture carries a secret or any tool-proxy naming (D-001/D-009).
 */

const MCP_AREAS = [mcpOk, mcpUnconfigured, mcpAuthNeeded, mcpError, mcpTimeout] as const;

test("the ready MCP row shows server, transport, capability counts, and freshness", () => {
  const { container } = render(<DoctorAreaRow area={mcpOk} />);
  const text = container.textContent ?? "";
  assert.ok(text.includes("2 servers (stdio+http)"), "server count + transport kinds");
  assert.ok(text.includes("2 ready"), "ready count");
  assert.ok(text.includes("11 tools / 3 resources / 2 prompts"), "capability counts");
  assert.ok(text.includes("checked 2m ago"), "cache freshness");
});

test("the unconfigured MCP row is a quiet not-checked line, not an error", () => {
  const { container } = render(<DoctorAreaRow area={mcpUnconfigured} />);
  assert.equal(mcpUnconfigured.status, "not_checked");
  assert.ok((container.textContent ?? "").includes("MCP is not configured."));
});

test("auth-needed shows its finding without expanding, with an actionable repair", () => {
  let clicked: DoctorFinding | null = null;
  const { container, getByRole } = render(
    <DoctorAreaRow area={mcpAuthNeeded} onAction={(finding) => (clicked = finding)} />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes('"linear"'), "the server needing auth is named");
  assert.ok(text.includes("needs authentication"));
  fireEvent.click(getByRole("button", { name: "Authenticate MCP" }));
  assert.equal((clicked as DoctorFinding | null)?.id, "mcp.status");
});

test("a failed server renders as an error with its sanitized crash detail", () => {
  const { container } = render(<DoctorAreaRow area={mcpError} />);
  const text = container.textContent ?? "";
  assert.equal(mcpError.status, "error");
  assert.ok(text.includes("code 127"), "the sanitized exit detail is visible");
  assert.ok(text.includes("Inspect the MCP integration"), "the inspect action is offered");
});

test("a handshake timeout renders as not-checked with a retry hint on expand", () => {
  const { container, getByRole } = render(<DoctorAreaRow area={mcpTimeout} />);
  assert.equal(mcpTimeout.status, "not_checked");
  assert.ok((container.textContent ?? "").includes("timed out after 30000ms"));
  // not_checked is a quiet state, so the retry action rests collapsed behind the row expander.
  fireEvent.click(getByRole("button", { name: /mcp area details/i }));
  assert.ok((container.textContent ?? "").includes("Re-run /doctor to retry"));
});

test("no MCP fixture leaks a secret or names tool-proxy (D-001/D-009)", () => {
  for (const area of MCP_AREAS) {
    const raw = JSON.stringify(area);
    assert.doesNotMatch(raw, /tool[-_ ]proxy/i, `${area.verdict} must not name tool-proxy`);
    assert.doesNotMatch(raw, /token=|bearer|api[-_]?key/i, `${area.verdict} must carry no secret`);
  }
});
