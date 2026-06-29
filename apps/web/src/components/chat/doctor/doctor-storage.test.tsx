import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import type { DoctorArea } from "@trevor/session";
import { test } from "vitest";
import { DoctorAreaRow } from "./doctor-area-row";
import { storageLegacyImportable, storageOk, storageRootInvalid } from "./doctor-fixtures";

/**
 * Plan 03 Phase 5: the Storage/Roots area renders through the generic doctor dashboard - a fact per
 * root plus inline findings only on a problem (a not-writable root or importable legacy data).
 */

test("a not-writable root renders an inline error finding with its repair action", () => {
  const { container } = render(<DoctorAreaRow area={storageRootInvalid} />);
  const text = container.textContent ?? "";
  assert.match(text, /state not writable/);
  assert.match(text, /Trevor cannot write this root/);
  assert.match(text, /Check permissions on/);
  assert.match(text, /\.local\/state\/trevorV2/);
});

test("importable legacy data renders an inline warning with the migration nudge", () => {
  const { container } = render(<DoctorAreaRow area={storageLegacyImportable} />);
  const text = container.textContent ?? "";
  assert.match(text, /Importable ~\/\.trevor data is present/);
  assert.match(text, /Import ~\/\.trevor data via migration/);
});

test("a healthy storage area rests as one line and reveals every root fact on expand", () => {
  const { container, getByLabelText } = render(<DoctorAreaRow area={storageOk} />);
  assert.match(container.textContent ?? "", /All roots resolved and writable/);

  fireEvent.click(getByLabelText("Storage / Roots area details"));
  const expanded = container.textContent ?? "";
  for (const label of ["config", "state", "legacy", "temp", "external:pi", "external:agents"]) {
    assert.ok(expanded.includes(label), `fact ${label} renders`);
  }
  assert.match(expanded, /external \(read-only\)/);
});

test("a very long root path renders without throwing", () => {
  const longPath = `~/.local/state/trevorV2/${"segment-".repeat(40)}end`;
  const area: DoctorArea = {
    id: "storage",
    label: "Storage / Roots",
    status: "error",
    verdict: "A storage root needs attention.",
    facts: [{ label: "state", value: `${longPath} · not writable`, status: "error" }],
    findings: [
      {
        id: "storage.state",
        status: "error",
        title: "state not writable",
        message: "Trevor cannot write this root.",
        source: longPath,
      },
    ],
  };
  const { container } = render(<DoctorAreaRow area={area} />);
  const text = container.textContent ?? "";
  assert.match(text, /state not writable/);
  assert.ok(text.includes("segment-segment-"), "the long path renders");
});
