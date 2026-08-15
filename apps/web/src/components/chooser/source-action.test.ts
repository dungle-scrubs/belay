import assert from "node:assert/strict";
import type { SourceAction } from "@belay/session";
import { test } from "vitest";
import { sourceActionCommand } from "./source-action";

/**
 * 53 D-003: the source-action dispatch. Pins that every action a source can offer maps to a DEFINED
 * command - in particular `configure` (the previously-dead button) surfaces the setup guidance instead
 * of no-op-ing - and that no action falls through to nothing.
 */

test("every offerable source action maps to a defined command (no silent no-op)", () => {
  // The actions the host catalog can announce for a source (model-source.ts `SourceAction`, minus the
  // never-offered `disable`). Each must resolve to a concrete effect, or the button is dead.
  const offerable: SourceAction[] = ["refresh", "authenticate", "reauthenticate", "configure"];
  for (const action of offerable) {
    assert.ok(sourceActionCommand(action), `"${action}" must map to a command`);
  }
});

test("configure surfaces the host auth-store setup guidance (the fixed dead button, 53 D-003)", () => {
  // The Direct-API "Configure" and the Claude subscription sign-in both route here: they open/keep the
  // source's SourceAuthPanel guidance rather than doing nothing (or a key-paste form).
  assert.deepEqual(sourceActionCommand("configure"), { kind: "show-setup-guidance" });
});

test("authenticate and reauthenticate share the sign-in effect; refresh refreshes the catalog", () => {
  assert.deepEqual(sourceActionCommand("authenticate"), { kind: "sign-in" });
  assert.deepEqual(sourceActionCommand("reauthenticate"), { kind: "sign-in" });
  assert.deepEqual(sourceActionCommand("refresh"), { kind: "refresh-catalog" });
});

test("the mapping covers the whole SourceAction union (including the never-offered disable)", () => {
  // Exhaustive over EVERY union member (not just the offerable ones), so a future action can't be
  // silently dropped - the same coverage the compile-time assertNever guard enforces.
  const all: SourceAction[] = ["authenticate", "reauthenticate", "refresh", "configure", "disable"];
  const kinds = new Set(all.map((a) => sourceActionCommand(a).kind));
  assert.deepEqual(
    kinds,
    new Set(["refresh-catalog", "sign-in", "show-setup-guidance", "disable"]),
  );
});
