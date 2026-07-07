/**
 * The `/new` browser-side UI command (plan 58 M4): typing `/new` creates a fresh project-scoped
 * session. With a path arg (`/new ~/dev/foo`) it launches a fresh session for that project; with no
 * arg it uses the current session's known root, or falls back to the New-session picker when no root
 * is resolvable. Like `/resume` and `/worktree`, `/new` is intercepted in the composer submit path
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
