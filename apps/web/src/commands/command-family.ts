/**
 * UI-neutral command-family contract (web-local for now).
 *
 * A "command family" is a slash command rich enough that selecting it opens a
 * helper UI (a builder + a guide) instead of just inserting text - e.g. `/loop`.
 * The descriptor is the grammar + help the guide renders; the parse result is
 * the bridge the builder renders. Neither knows anything about React: any UI can
 * consume them.
 *
 * This lives in `apps/web` so it can ship in Storybook without touching the
 * agent host. When the host adopts it, the descriptor + parser move into
 * `@trevor/session` and the host parses authoritatively over the same shapes;
 * the browser keeps parsing locally on every keystroke for responsiveness.
 */

/** A keyword in a family's creation grammar, shown as a chip in the guide. */
export interface CommandKeyword {
  readonly keyword: string;
  /** The value form shown after the keyword, e.g. `<n>`, `<interval>`, `"…"`. `null` for a bare flag. */
  readonly arg: string | null;
}

/** A runnable example shown in the guide; picking it fills the composer. */
export interface CommandExample {
  readonly text: string;
  readonly note: string;
}

/**
 * Everything a UI needs to present a command family without re-implementing its
 * grammar: the names that open it, the summary for the menu row, the guide
 * description, the keyword reference, the control verbs, and examples.
 */
export interface CommandFamilyDescriptor {
  readonly id: string;
  /** Command names that open this family, e.g. `["/loop", "/loops"]`. */
  readonly names: readonly string[];
  /** One-line summary for the command-menu row. */
  readonly summary: string;
  /** Short paragraph shown at the top of the guide. */
  readonly description: string;
  /** Creation keywords, in the order the guide lists them. */
  readonly keywords: readonly CommandKeyword[];
  /** The legend the builder lights up as each keyword is used. */
  readonly legendKeywords: readonly string[];
  /** Control verbs (`stop`, `pause`, …) that route to lifecycle actions. */
  readonly controlVerbs: readonly string[];
  readonly examples: readonly CommandExample[];
}

/** What kind of command the typed input resolves to. */
export type CommandParseMode = "create" | "control" | "list" | "invalid";

/** The role a single token plays, for syntax highlighting the composer. */
export type CommandTokenKind = "command" | "subcommand" | "keyword" | "value" | "flag" | "unknown";

/** A token's span into the raw input plus its semantic role. */
export interface CommandToken {
  /** Inclusive start offset into the raw input. */
  readonly start: number;
  /** Exclusive end offset into the raw input. */
  readonly end: number;
  readonly kind: CommandTokenKind;
  /** Set when `kind` is `keyword`/`flag`: the keyword text. */
  readonly keyword?: string;
  /** Set when `kind` is `value`: the field the value fills. */
  readonly field?: string;
}

export type CommandDiagnosticSeverity = "error" | "info";

export interface CommandDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: CommandDiagnosticSeverity;
}

/**
 * One rendered row of the builder: a labelled field with its current value, or a
 * flagged gap with the hint that fills it. The parser owns row order and labels
 * so every UI shows the same builder without re-deriving them.
 */
export interface CommandFieldRow {
  /** Stable field key, e.g. `runner`, `action`, `bound`. */
  readonly field: string;
  readonly label: string;
  /** The parsed value, or `undefined` when the field is unset. */
  readonly value: string | undefined;
  /** True when this row is a required-but-absent gap. */
  readonly missing: boolean;
  /** Shown when the row is missing or optional-and-empty. */
  readonly hint?: string;
}

/**
 * The semantic preview of a typed command: enough structure for any UI to render
 * the builder (rows + ready), highlight the composer (tokens), and prompt next
 * input (used vs available keywords, missing). The bridge between parser and UI.
 */
export interface CommandParseResult {
  readonly command: string;
  readonly mode: CommandParseMode;
  readonly tokens: readonly CommandToken[];
  /** Legend keywords already present in the input. */
  readonly usedKeywords: readonly string[];
  /** Legend keywords still valid to add. */
  readonly availableKeywords: readonly string[];
  /** Ordered builder rows (set values and missing gaps). */
  readonly fields: readonly CommandFieldRow[];
  /** Semantic keys of required-but-absent parts, e.g. `action`, `bound`. */
  readonly missing: readonly string[];
  readonly diagnostics: readonly CommandDiagnostic[];
  /** True only when the input is a complete, valid, activatable command. */
  readonly ready: boolean;
}
