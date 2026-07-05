/**
 * The `/new` browser-side UI command (plan 44.2, D-001): typing `/new` opens the New-session picker,
 * exactly as the sidebar `＋ New session` affordance does - both share one open-picker entry so they
 * cannot drift. Like `/resume` and `/worktree`, `/new` is intercepted in the composer submit path
 * BEFORE the host command lane, so it never reaches the model or the host; it is pure browser UI and
 * injects no transcript content.
 *
 * This module owns the command descriptor (which feeds the slash autocomplete via `BUILT_IN_COMMANDS`)
 * and the submit-intercept matcher, so the shown command and the intercept condition are one source of
 * truth and both are unit-tested apart from the App shell.
 */
export const NEW_SESSION_COMMAND = {
  name: "/new",
  summary: "Start a session in a folder",
} as const;

/**
 * True when a submitted line is the `/new` UI command - either bare (`/new`) or with a trailing
 * argument (`/new ~/dev/foo`), mirroring the `/resume` intercept shape exactly. A longer command that
 * merely starts with the same letters (`/news`) or an embedded `/new` is NOT the command. Callers pass
 * the already-trimmed submit text.
 */
export function isNewSessionCommand(text: string): boolean {
  return text === NEW_SESSION_COMMAND.name || text.startsWith(`${NEW_SESSION_COMMAND.name} `);
}
