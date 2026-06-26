import assert from "node:assert/strict";
import { TOOL_NAMES } from "@trevor/session";
import { test } from "vitest";
import { buildCommandRegistry } from "../commands";
import { sessionRecallTool } from "./session-recall";

/**
 * D-044 M4/M6: session_recall is a MODEL-FACING TOOL, not a slash command. The first cut adds no
 * `/recall` command - the model invokes it only when the user asks for older project/session
 * memory. These pin the tool's read-only nature, its presence in the shared tool vocabulary, and
 * the deliberate ABSENCE of any recall slash command.
 */

test("session_recall is a read-only tool in the shared vocabulary", () => {
  assert.equal(sessionRecallTool.name, "session_recall");
  assert.equal(sessionRecallTool.readOnly, true, "recall only reads durable logs");
  assert.ok(TOOL_NAMES.includes("session_recall"), "it is in the cross-surface tool table");
});

test("no recall slash command is registered (first cut is a tool only)", () => {
  const specs = buildCommandRegistry().specs.map((s) => s.name.toLowerCase());
  assert.ok(
    !specs.some((name) => name.includes("recall")),
    `no command mentions recall; registered: ${specs.join(", ")}`,
  );
});

test("the tool description steers the model to older project memory, not code search", () => {
  const description = sessionRecallTool.description.toLowerCase();
  assert.ok(description.includes("project"), "scopes recall to the project's memory");
  assert.ok(
    description.includes("does not search code") ||
      (description.includes("not") && description.includes("code")),
    "tells the model recall is not codebase search",
  );
});
