import { type CommandMenuPayload, findMenuRow } from "@trevor/session";

/**
 * Output-style metadata and the `/style` command logic (plan 03, M4-M6). Styles are HOST-owned: each is
 * a stable id, label, description, and a one-line response-shape `guidance` that is the ONLY thing a
 * style threads into a turn (presentation only - never model, tools, reasoning, agents, or routing). The
 * bare `/style` command renders as a nested command-menu payload (so the web needs no style-specific
 * code); selecting a row dispatches `/style <id>` back through the command path. Pure + data-driven, so
 * the metadata is reusable by settings, `/doctor`, and future surfaces, and every branch is unit-tested.
 */

export interface OutputStyle {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The response-shape guidance threaded into the turn (presentation only). Empty for the default. */
  readonly guidance: string;
  /** The built-in fallback style (exactly one). */
  readonly isDefault?: boolean;
}

/** The built-in output styles. The default carries no guidance (Trevor's standard voice). */
export const BUILTIN_STYLES: readonly OutputStyle[] = [
  {
    id: "default",
    label: "Default",
    description: "Trevor's standard voice",
    guidance: "",
    isDefault: true,
  },
  {
    id: "concise",
    label: "Concise",
    description: "Short, direct answers",
    guidance: "Answer in as few words as correctness allows; lead with the result, skip preamble.",
  },
  {
    id: "diagnostic",
    label: "Diagnostic",
    description: "Surface reasoning and checks",
    guidance:
      "Show the key reasoning steps and the checks you ran; call out assumptions and what would falsify them.",
  },
  {
    id: "reviewer",
    label: "Reviewer",
    description: "Terse, finding-oriented",
    guidance:
      "Respond as a code reviewer: a prioritized list of findings with file:line and a concrete fix each.",
  },
  {
    id: "explanatory",
    label: "Explanatory",
    description: "Teach as you go",
    guidance:
      "Explain the why as you answer, building the reader's mental model with brief examples.",
  },
];

/** The id of the built-in default style. */
export const DEFAULT_STYLE_ID = "default";

/** The default style record (the fallback for an unknown/retired id). */
export function defaultStyle(): OutputStyle {
  return BUILTIN_STYLES.find((s) => s.isDefault) ?? BUILTIN_STYLES[0]!;
}

/** A style by id, or null when no built-in style matches (a retired/unknown id). */
export function findStyle(id: string): OutputStyle | null {
  return BUILTIN_STYLES.find((s) => s.id === id) ?? null;
}

/** Resolves an id to a real style, falling back to the default for an unknown/retired id. */
export function resolveStyle(id: string | null | undefined): OutputStyle {
  return (id ? findStyle(id) : null) ?? defaultStyle();
}

/** The bare `/style` menu: one row per built-in style, the active one marked selected, the default
 *  badged, plus a reset action. A pure projection of the metadata - the only `/style`-specific code. */
export function buildStyleMenu(activeId: string): CommandMenuPayload {
  const rows = BUILTIN_STYLES.map((style) => ({
    id: style.id,
    label: style.label,
    description: style.description,
    ...(style.id === activeId ? { selected: true } : {}),
    ...(style.isDefault ? { badge: "default" } : {}),
  }));
  return { family: "style", title: "Output style", searchable: true, rows };
}

/** The outcome of a `/style` invocation, for the command handler to render + persist. */
export type StyleCommandResult =
  /** Bare `/style`: show the menu (no change). */
  | { readonly kind: "menu"; readonly menu: CommandMenuPayload }
  /** A style was selected: persist `styleId` and confirm. */
  | { readonly kind: "selected"; readonly styleId: string; readonly text: string }
  /** An unknown id / bad action: surface the error without changing the active style. */
  | { readonly kind: "error"; readonly text: string };

/**
 * Pure `/style` argument handling. Bare (or `menu`/`list`) shows the menu for `activeId`; `reset` or
 * `default` selects the default; any other token selects that style id when it is a real built-in style,
 * else returns a structured error (the active style is unchanged). `select <id>` is also accepted so the
 * web's menu-row dispatch and a typed command share one path.
 */
export function handleStyleCommand(rawArgs: string, activeId: string): StyleCommandResult {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  const verb = tokens[0]?.toLowerCase();

  if (!verb || verb === "menu" || verb === "list") {
    return { kind: "menu", menu: buildStyleMenu(activeId) };
  }
  if (verb === "reset" || verb === "default") {
    return { kind: "selected", styleId: DEFAULT_STYLE_ID, text: "✓ output style reset to default" };
  }
  const id = verb === "select" ? tokens[1]?.toLowerCase() : verb;
  const style = id ? findStyle(id) : null;
  if (!style) {
    return {
      kind: "error",
      text: `unknown style: ${id ?? "(none)"} - run /style to see the choices`,
    };
  }
  return { kind: "selected", styleId: style.id, text: `✓ output style: ${style.label}` };
}

/** Whether `actionId` (from a menu-row dispatch) names a selectable built-in style - the dispatch guard. */
export function isStyleActionId(actionId: string): boolean {
  return findMenuRow(buildStyleMenu(DEFAULT_STYLE_ID).rows, actionId) !== null;
}
