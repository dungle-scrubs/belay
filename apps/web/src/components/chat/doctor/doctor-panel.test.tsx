import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import type { DoctorFinding, DoctorSnapshot } from "@trevor/session";
import { afterEach, beforeEach, test } from "vitest";
import { DoctorPanel } from "./doctor-panel";

/**
 * D-073 M5/M7: the Doctor dashboard behavior. Covers severity filtering, area expand/collapse,
 * next-action clicks, the refresh / copy / JSON inspection affordances, and the accessibility
 * labels - so the panel says what's wrong and the inspection actions act on the sanitized snapshot.
 */

const SNAPSHOT: DoctorSnapshot = {
  state: "ready",
  checkedAt: "12s ago",
  host: { workspace: "~/dev/trevorV2" },
  areas: [
    {
      id: "core",
      label: "Core",
      status: "ok",
      verdict: "running",
      facts: [{ label: "uptime", value: "2h 14m" }],
      findings: [{ id: "core.process", status: "ok", title: "Host process", message: "running" }],
    },
    {
      id: "providers",
      label: "Providers",
      status: "error",
      verdict: "no auth",
      findings: [
        {
          id: "providers.gpt.auth",
          status: "error",
          title: "GPT-5.5 missing API key",
          message: "No credentials resolved.",
          nextAction: { label: "Add the key", command: "opchain primary" },
        },
      ],
    },
  ],
};

test("issues-only filter keeps the error area and hides the healthy one", () => {
  const { container, getByRole } = render(<DoctorPanel snapshot={SNAPSHOT} />);
  // Both areas visible initially.
  assert.ok((container.textContent ?? "").includes("Core"));
  assert.ok((container.textContent ?? "").includes("Providers"));

  fireEvent.click(getByRole("button", { name: /issues only/i }));
  const text = container.textContent ?? "";
  assert.ok(!text.includes("Host process"), "the healthy Core area is filtered out");
  assert.ok(text.includes("Providers"), "the error area stays - it can never be hidden");
});

test("an area expands to reveal its secondary facts", () => {
  const { getByRole, queryByText } = render(<DoctorPanel snapshot={SNAPSHOT} />);
  assert.equal(queryByText("2h 14m"), null, "facts are collapsed at rest");
  fireEvent.click(getByRole("button", { name: /core area details/i }));
  assert.ok(queryByText("2h 14m"), "expanding the area reveals the fact");
});

test("a healthy area keeps its findings collapsed so the panel rests compact (D-073)", () => {
  // The host attaches an informational finding to EVERY area; on a healthy area it must stay
  // collapsed, or an all-green panel expands into a wall of findings (the reported "way too big").
  const { getByRole, queryByText } = render(<DoctorPanel snapshot={SNAPSHOT} />);
  assert.equal(queryByText("Host process"), null, "the OK area's finding is collapsed at rest");
  fireEvent.click(getByRole("button", { name: /core area details/i }));
  assert.ok(queryByText("Host process"), "expanding the healthy area reveals its finding");
});

test("a problem area always shows its findings without expanding (D-073)", () => {
  const { queryByText } = render(<DoctorPanel snapshot={SNAPSHOT} />);
  assert.ok(
    queryByText("GPT-5.5 missing API key"),
    "an error area's finding is always shown - a problem can never be collapsed away",
  );
});

test("clicking a finding's next action fires onAction with that finding", () => {
  let clicked: DoctorFinding | null = null;
  const { getByRole } = render(
    <DoctorPanel snapshot={SNAPSHOT} onAction={(finding) => (clicked = finding)} />,
  );
  fireEvent.click(getByRole("button", { name: "Add the key" }));
  assert.equal((clicked as DoctorFinding | null)?.id, "providers.gpt.auth");
});

test("refresh is shown only when wired, and fires its callback", () => {
  const noRefresh = render(<DoctorPanel snapshot={SNAPSHOT} />);
  assert.equal(
    noRefresh.queryByRole("button", { name: /refresh diagnostics/i }),
    null,
    "no refresh control without a handler",
  );
  noRefresh.unmount();

  let refreshed = 0;
  const { getByRole } = render(
    <DoctorPanel snapshot={SNAPSHOT} onRefresh={() => (refreshed += 1)} />,
  );
  fireEvent.click(getByRole("button", { name: /refresh diagnostics/i }));
  assert.equal(refreshed, 1);
});

test("view JSON toggles the raw sanitized snapshot in/out", () => {
  const { getByRole, queryByRole } = render(<DoctorPanel snapshot={SNAPSHOT} />);
  assert.equal(
    queryByRole("group", { name: "Doctor snapshot JSON" }),
    null,
    "JSON hidden by default",
  );

  const jsonButton = getByRole("button", { name: /view json/i });
  fireEvent.click(jsonButton);
  const view = queryByRole("figure", { name: "Doctor snapshot JSON" });
  assert.ok(view, "the JSON view appears");
  assert.ok((view?.textContent ?? "").includes('"providers.gpt.auth"'), "it shows the snapshot");
  assert.equal(jsonButton.getAttribute("aria-pressed"), "true");

  fireEvent.click(jsonButton);
  assert.equal(
    queryByRole("figure", { name: "Doctor snapshot JSON" }),
    null,
    "toggling hides it again",
  );
});

test("the panel is a labelled region for assistive tech", () => {
  const { getByRole } = render(<DoctorPanel snapshot={SNAPSHOT} />);
  assert.ok(getByRole("region", { name: "Doctor diagnostics" }), "region landmark with a label");
});

// --- copy report writes the sanitized text report to the clipboard ----------

let written: string[] = [];
const originalClipboard = globalThis.navigator?.clipboard;

beforeEach(() => {
  written = [];
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        written.push(text);
        return Promise.resolve();
      },
    },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
});

test("copy report writes the sanitized text report to the clipboard", () => {
  const { getByRole } = render(<DoctorPanel snapshot={SNAPSHOT} />);
  fireEvent.click(getByRole("button", { name: /copy report/i }));
  assert.equal(written.length, 1);
  const report = written[0] ?? "";
  assert.ok(report.includes("Trevor /doctor"), "header line present");
  assert.ok(report.includes("GPT-5.5 missing API key"), "a finding is in the report");
});
