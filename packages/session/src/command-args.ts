/**
 * Custom-slash-command ARGUMENT SUBSTITUTION (plan 44.5): a pure, dependency-free tokenizer +
 * substituter for `.belay/commands/*.md` bodies that carry `$0`/`$1`/`$ARGUMENTS` placeholders.
 * Born in `@belay/session` so the two authorities share ONE engine (the `command-family.ts:10` hoist
 * doctrine, following the `loop-parser.ts` precedent): the HOST expands a command body authoritatively
 * at dispatch, and the WEB previews the same expansion on every keystroke - never two subtly-different
 * substitution rules.
 *
 * This owns TOKENIZATION + SUBSTITUTION only. It reads no disk, dispatches nothing, and - crucially -
 * is a DIFFERENT feature from `interpolation-engine.ts` (the plan-40 `!command` expander): interpolation
 * RUNS an allow-listed command and splices its output; substitution only maps `$N`/`$ARGUMENTS` to the
 * user's typed arguments. The token spaces are orthogonal, and the host applies them in a fixed order -
 * interpolate the trusted body FIRST, then substitute the user args (D-007) - so a `$N` value that
 * happens to contain `!cmd` can never introduce an interpolation site.
 *
 * Responsible for: shell-style arg tokenization ({@link tokenizeArgs}/{@link scanArgs}) and
 * `$`-placeholder substitution ({@link expandArgs}) with an inspectable diagnostics record.
 * Not for: reading command files off disk (apps/agent-host/src/commands), `!command` interpolation
 * (interpolation-engine.ts), or dispatching the expanded prompt (main.ts).
 */

/** Whitespace that separates unquoted argument tokens (mirrors a shell's IFS default set). */
const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);

/** The outcome of scanning a raw argument line: the token list plus whether a quote was left open. */
export interface ArgScan {
  /** The parsed tokens, quotes stripped and escapes resolved. */
  readonly tokens: string[];
  /** True when a `'`/`"` span was opened but never closed - the scanner consumed to end of input. */
  readonly unterminatedQuote: boolean;
}

/**
 * Scans a raw argument line into shell-style tokens. Whitespace splits; single AND double quotes group
 * their span and are stripped; a backslash escapes the next char (`a\ b` -> `a b`, `\"x` -> `"x`).
 * Inside single quotes a backslash is literal (shell semantics); inside double quotes and unquoted text
 * it escapes. An unterminated quote is not an error here - the span is consumed to end of input and
 * {@link ArgScan.unterminatedQuote} is set, so the caller decides whether to surface it.
 *
 * Richer than `loop-parser.ts`'s double-quote-only regex (D-003): a char-scanner is needed for single
 * quotes AND backslash escapes, which a regex split cannot express cleanly.
 */
export function scanArgs(raw: string): ArgScan {
  const tokens: string[] = [];
  let current = "";
  // Tracks whether the current token has been STARTED (so an empty quoted `""` still emits one token,
  // distinct from the between-tokens whitespace state where `current` is also "").
  let started = false;
  let unterminatedQuote = false;
  let i = 0;

  const push = (): void => {
    if (started) {
      tokens.push(current);
      current = "";
      started = false;
    }
  };

  while (i < raw.length) {
    const ch = raw[i] as string;

    if (WHITESPACE.has(ch)) {
      push();
      i += 1;
      continue;
    }

    if (ch === "\\") {
      const next = raw[i + 1];
      // A trailing backslash (no next char) stays literal; otherwise the next char is taken literally.
      current += next ?? "\\";
      started = true;
      i += next === undefined ? 1 : 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      started = true;
      i += 1;
      let closed = false;
      while (i < raw.length) {
        const c = raw[i] as string;
        // Backslash escapes only inside DOUBLE quotes; inside single quotes everything is literal.
        if (c === "\\" && ch === '"') {
          const next = raw[i + 1];
          current += next ?? "\\";
          i += next === undefined ? 1 : 2;
          continue;
        }
        if (c === ch) {
          closed = true;
          i += 1;
          break;
        }
        current += c;
        i += 1;
      }
      if (!closed) {
        unterminatedQuote = true;
      }
      continue;
    }

    current += ch;
    started = true;
    i += 1;
  }

  push();
  return { tokens, unterminatedQuote };
}

/** The shell-style token list for a raw argument line (quotes stripped, escapes resolved). The simple
 *  surface most callers want; {@link scanArgs} additionally reports the unterminated-quote flag. */
export function tokenizeArgs(raw: string): string[] {
  return scanArgs(raw).tokens;
}

/**
 * The inspectable record {@link expandArgs} returns alongside the expanded text (the observability seam
 * at the dispatch boundary + the web preview). Deliberately MIRRORS `InterpolationDiagnostic`'s
 * "counts + low-cardinality names, never raw values" spirit without reusing it - this is a different
 * feature (substitution, not `!command` interpolation, D-008), so it owns its own shape.
 */
export interface CommandArgDiagnostics {
  /** The distinct placeholders the template referenced, in first-seen order (`$0`, `$1`, `$ARGUMENTS`). */
  readonly referenced: readonly string[];
  /** How many argument tokens the raw line produced. */
  readonly providedCount: number;
  /** The referenced `$N` placeholders that were out of range and defaulted to "" (D-004). */
  readonly missing: readonly string[];
  /** Whether the raw args left a `'`/`"` span open (surfaced from the tokenizer). */
  readonly unterminatedQuote: boolean;
  /** Whether the no-placeholder CC-parity default appended a trailing `ARGUMENTS:` block. */
  readonly appendedArguments: boolean;
}

/** The result of expanding a command-body template: the substituted text plus its diagnostics. */
export interface CommandArgExpansion {
  readonly text: string;
  readonly diagnostics: CommandArgDiagnostics;
}

/** Matches the placeholder body immediately after a `$`: `ARGUMENTS`, or one-or-more digits (`$0`, `$12`). */
const PLACEHOLDER = /^(ARGUMENTS|[0-9]+)/;

/**
 * Expands a command-body `template` against a raw argument line. Two orthogonal placeholder forms:
 *   - `$N` -> the Nth token, 0-based (`$0` is the first arg, D-001); out of range -> "" (D-004).
 *   - `$ARGUMENTS` -> the raw line VERBATIM as typed (D-002), carried separately from the token list so
 *     it is never the re-joined tokens (internal whitespace/quotes survive).
 * A backslash escapes the following char in a single pass (D-003): `\$1` stays the literal `$1`, while
 * `\\$1` is one literal backslash followed by the expanded `$1`. An unrecognized `$word` (or a lone `$`)
 * is passed through untouched.
 *
 * When the template references NO placeholder at all and the args are non-empty, the raw args are
 * appended as a trailing `ARGUMENTS: <raw>` block (Claude-Code parity) so a placeholder-free command
 * body still receives its input. An escaped `\$0` is literal, not a reference, so it does NOT suppress
 * this append.
 */
export function expandArgs(template: string, raw: string): CommandArgExpansion {
  const scan = scanArgs(raw);
  const referenced: string[] = [];
  const missing: string[] = [];
  let sawPlaceholder = false;
  let out = "";
  let i = 0;

  const note = (name: string, into: string[]): void => {
    if (!into.includes(name)) {
      into.push(name);
    }
  };

  while (i < template.length) {
    const ch = template[i] as string;

    if (ch === "\\") {
      const next = template[i + 1];
      // `\\` -> one literal backslash; `\$` -> a literal `$` (its placeholder is NOT expanded). Before
      // any other char the backslash is kept literal (it only escapes `\` and `$`).
      if (next === "\\" || next === "$") {
        out += next;
        i += 2;
      } else {
        out += "\\";
        i += 1;
      }
      continue;
    }

    if (ch === "$") {
      const match = PLACEHOLDER.exec(template.slice(i + 1));
      if (match) {
        const body = match[0];
        sawPlaceholder = true;
        if (body === "ARGUMENTS") {
          note("$ARGUMENTS", referenced);
          out += raw;
        } else {
          const name = `$${body}`;
          note(name, referenced);
          const value = scan.tokens[Number(body)];
          if (value === undefined) {
            note(name, missing);
          } else {
            out += value;
          }
        }
        i += 1 + body.length;
        continue;
      }
      // A lone `$` or an unknown `$word` is not a placeholder - pass it through literally.
      out += "$";
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  let appendedArguments = false;
  if (!sawPlaceholder && raw.trim().length > 0) {
    out += `\n\nARGUMENTS: ${raw}`;
    appendedArguments = true;
  }

  return {
    text: out,
    diagnostics: {
      referenced,
      providedCount: scan.tokens.length,
      missing,
      unterminatedQuote: scan.unterminatedQuote,
      appendedArguments,
    },
  };
}
