import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import type { DoctorFinding } from "@trevor/session";
import { test } from "vitest";
import { DoctorAreaRow } from "./doctor-area-row";
import {
  hooksLegacyMigration,
  hooksMissingScript,
  hooksOk,
  hooksSlow,
  hooksTrustChanged,
  hooksUnapproved,
  hooksUnconfigured,
} from "./doctor-fixtures";

/**
 * Plan 25 M9: the Hooks status states rendered through the generic doctor peripheral mapping.
 * The fixtures mirror the HOST's real Hooks area shape (doctor/hooks-status fold ->
 * peripheralArea + extra findings), so these pin what the browser actually shows per state:
 * the ready counts/trust rollup, the approval warning with its guidance, the missing-script and
 * degrading-handler warnings, the legacy HOOK.md migration guidance - and that no fixture
 * carries a hook's arguments, output, or any secret (D-009).
 */

const HOOKS_AREAS = [
  hooksOk,
  hooksUnconfigured,
  hooksUnapproved,
  hooksTrustChanged,
  hooksMissingScript,
  hooksSlow,
  hooksLegacyMigration,
] as const;

test("the ready Hooks row shows counts by event type and the trust rollup", () => {
  const { container } = render(<DoctorAreaRow area={hooksOk} />);
  const text = container.textContent ?? "";
  assert.ok(text.includes("2 hooks"), "hook count");
  assert.ok(text.includes("1 PreToolUse"), "PreToolUse count");
  assert.ok(text.includes("1 Stop"), "Stop count");
  assert.ok(text.includes("2 approved"), "trust rollup");
});

test("the unconfigured Hooks row is a quiet not-checked line, not an error", () => {
  const { container } = render(<DoctorAreaRow area={hooksUnconfigured} />);
  assert.equal(hooksUnconfigured.status, "not_checked");
  assert.ok((container.textContent ?? "").includes("Hooks is not configured."));
});

test("an unapproved hook shows the approval warning with actionable guidance", () => {
  let clicked: DoctorFinding | null = null;
  const { container, getByRole } = render(
    <DoctorAreaRow area={hooksUnapproved} onAction={(finding) => (clicked = finding)} />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("project:fmt"), "the unapproved hook is named");
  assert.match(text, /never executes until/i);
  fireEvent.click(getByRole("button", { name: "Review each hook, then approve its trust hash" }));
  assert.equal((clicked as DoctorFinding | null)?.id, "hooks.approval");
});

test("a changed trust hash reads as re-approval, not a fresh approval", () => {
  const { container } = render(<DoctorAreaRow area={hooksTrustChanged} />);
  assert.match(container.textContent ?? "", /changed since approval/i);
  assert.match(container.textContent ?? "", /RE-approval/);
});

test("a missing script warns and names the hook with a repair action", () => {
  const { container } = render(<DoctorAreaRow area={hooksMissingScript} />);
  const text = container.textContent ?? "";
  assert.match(text, /command script does not exist/i);
  assert.ok(text.includes("project:fmt"));
  assert.ok(text.includes("Restore the script or remove the hook"));
});

test("a degrading handler warns with its timeout record from the stats snapshot", () => {
  const { container } = render(<DoctorAreaRow area={hooksSlow} />);
  const text = container.textContent ?? "";
  assert.ok(text.includes("project:audit"), "the degrading hook is named");
  assert.match(text, /timed out 3 of 14 runs/);
});

test("a legacy HOOK.md warns with migration guidance and an abbreviated path", () => {
  const { container } = render(<DoctorAreaRow area={hooksLegacyMigration} />);
  const text = container.textContent ?? "";
  assert.match(text, /HOOK\.md/);
  assert.match(text, /never execute in V2/i);
  assert.ok(text.includes("~/dev/app/.trevor/hooks/fmt/HOOK.md"), "abbreviated path shown");
  assert.ok(text.includes("Migrate each handler to a hooks.json entry"));
});

test("no Hooks fixture leaks a hook argument, output, or secret (D-009)", () => {
  for (const area of HOOKS_AREAS) {
    const raw = JSON.stringify(area);
    assert.doesNotMatch(raw, /token=|bearer|api[-_]?key/i, `${area.verdict} must carry no secret`);
    assert.doesNotMatch(raw, /"arguments"|"stdout"|"stderr"/, `${area.verdict} carries no output`);
    assert.ok(!raw.includes("/Users/"), `${area.verdict} abbreviates home paths`);
  }
});
