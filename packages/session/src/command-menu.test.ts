import { describe, expect, test } from "vitest";
import {
  type CommandMenuPayload,
  decodeCommandMenu,
  decodeCommandMenuRow,
  filterMenuRows,
  findMenuRow,
  isActionable,
  isSubmenu,
} from "./command-menu";
import type { SessionEvent } from "./event";
import { events } from "./protocol";
import { decodeTrevorEvent } from "./protocol-decode";

/** Wraps a constructor's `{ type, payload }` into a full wire `SessionEvent` for decode round-trips. */
function wire(input: { readonly type: string; readonly payload: unknown }): SessionEvent {
  return {
    createdAt: "2026-06-29T00:00:00.000Z",
    eventId: "e1",
    producerId: "belay-host",
    seq: 1,
    sessionId: "s1",
    type: input.type,
    payload: input.payload as SessionEvent["payload"],
  };
}

const STYLE_MENU: CommandMenuPayload = {
  family: "style",
  title: "Output style",
  searchable: true,
  rows: [
    { id: "concise", label: "Concise", description: "Short answers", selected: true },
    { id: "diagnostic", label: "Diagnostic", description: "Show reasoning" },
    { id: "reset", label: "Reset to default", badge: "default" },
    {
      id: "advanced",
      label: "Advanced",
      children: [
        { id: "reviewer", label: "Reviewer" },
        { id: "explanatory", label: "Explanatory", disabledReason: "coming soon" },
      ],
    },
  ],
};

describe("row classification", () => {
  test("a leaf row with no disabled reason is actionable", () => {
    expect(isActionable({ id: "concise", label: "Concise" })).toBe(true);
    expect(isSubmenu({ id: "concise", label: "Concise" })).toBe(false);
  });

  test("a disabled row is not actionable", () => {
    expect(isActionable({ id: "x", label: "X", disabledReason: "nope" })).toBe(false);
  });

  test("a row with children is a submenu, not an action", () => {
    const row = STYLE_MENU.rows[3];
    if (!row) throw new Error("fixture row missing");
    expect(isSubmenu(row)).toBe(true);
    expect(isActionable(row)).toBe(false);
  });
});

describe("filterMenuRows", () => {
  test("empty query returns rows unchanged", () => {
    expect(filterMenuRows(STYLE_MENU.rows, "  ")).toBe(STYLE_MENU.rows);
  });

  test("matches label or description, case-insensitively", () => {
    expect(filterMenuRows(STYLE_MENU.rows, "REASON").map((r) => r.id)).toEqual(["diagnostic"]);
  });

  test("keeps a submenu parent when a child matches", () => {
    expect(filterMenuRows(STYLE_MENU.rows, "reviewer").map((r) => r.id)).toEqual(["advanced"]);
  });
});

describe("findMenuRow", () => {
  test("finds a top-level row", () => {
    expect(findMenuRow(STYLE_MENU.rows, "diagnostic")?.label).toBe("Diagnostic");
  });

  test("finds a row nested in a submenu", () => {
    expect(findMenuRow(STYLE_MENU.rows, "reviewer")?.label).toBe("Reviewer");
  });

  test("returns null for an unknown id", () => {
    expect(findMenuRow(STYLE_MENU.rows, "nope")).toBeNull();
  });
});

describe("decode (permissive, backward-compatible)", () => {
  test("round-trips a full menu", () => {
    expect(decodeCommandMenu(STYLE_MENU)).toEqual(STYLE_MENU);
  });

  test("drops rows missing id/label but keeps the menu", () => {
    const decoded = decodeCommandMenu({
      family: "style",
      title: "Output style",
      rows: [{ id: "ok", label: "Ok" }, { id: "no-label" }, "garbage", { label: "no-id" }],
    });
    expect(decoded?.rows.map((r) => r.id)).toEqual(["ok"]);
  });

  test("returns null when core fields are missing (so a plain command result still renders text)", () => {
    expect(decodeCommandMenu(undefined)).toBeNull();
    expect(decodeCommandMenu({ title: "no family", rows: [] })).toBeNull();
    expect(decodeCommandMenu({ family: "x", title: "y" })).toBeNull(); // no rows array
  });

  test("decodeCommandMenuRow drops an unusable child but keeps the valid siblings", () => {
    const row = decodeCommandMenuRow({
      id: "advanced",
      label: "Advanced",
      children: [{ id: "a", label: "A" }, { id: "no-label" }],
    });
    expect(row?.children?.map((c) => c.id)).toEqual(["a"]);
  });

  test("ignores wrong-typed optional fields rather than failing", () => {
    const row = decodeCommandMenuRow({ id: "x", label: "X", badge: 42, selected: "yes" });
    expect(row).toEqual({ id: "x", label: "X" }); // badge/selected dropped (wrong types)
  });
});

describe("command.result carries the menu over the wire (backward-compatible)", () => {
  test("a result WITH a menu round-trips through the real event decode", () => {
    const decoded = decodeTrevorEvent(
      wire(
        events.commandResult({
          command: "/style",
          text: "Output style",
          ok: true,
          menu: STYLE_MENU,
        }),
      ),
    );
    expect(decoded?.type).toBe("command.result");
    if (decoded?.type !== "command.result") return;
    expect(decoded.menu).toEqual(STYLE_MENU);
  });

  test("a plain result (no menu) decodes unchanged, with no menu field", () => {
    const decoded = decodeTrevorEvent(
      wire(events.commandResult({ command: "/help", text: "the help text", ok: true })),
    );
    expect(decoded?.type).toBe("command.result");
    if (decoded?.type !== "command.result") return;
    expect(decoded.menu).toBeUndefined();
    expect(decoded.text).toBe("the help text");
  });

  test("a focus session hint round-trips without requiring a menu", () => {
    const decoded = decodeTrevorEvent(
      wire(
        events.commandResult({
          command: "/worktree-new",
          text: "created",
          ok: true,
          focusSessionId: "worktree-session",
        }),
      ),
    );
    expect(decoded?.type).toBe("command.result");
    if (decoded?.type !== "command.result") return;
    expect(decoded.focusSessionId).toBe("worktree-session");
    expect(decoded.menu).toBeUndefined();
  });
});
