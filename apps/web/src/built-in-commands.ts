import { NEW_SESSION_COMMAND } from "./new-session/new-session-command";

/**
 * The browser-side built-in slash commands (plan 58 M4/M8): the commands the web announces ON TOP of
 * the host's `host.online` command specs, so the slash autocomplete + `parseCommand` allow-set cover
 * the browser-owned UI commands (`/new`, `/cd`, `/resume`, `/worktree`) even before a host is live.
 *
 * `/clear` is intentionally ABSENT (plan 58 M4): fresh context is now `/new` (a fresh project-scoped
 * session), not a destructive in-place clear. The programmatic `/clear` handler stays in the host for
 * replay compatibility with legacy sessions, but it is never listed here. Extracted from app.tsx so the
 * regression test can pin that `/clear` is retired from the visible command surface and `/new` + `/cd`
 * are present.
 */
export const BUILT_IN_COMMANDS = [
  // /clear is retired from visible surfaces (plan 58 M4): /new replaces it. The programmatic
  // /clear handler stays in the host for replay compatibility with legacy sessions.
  NEW_SESSION_COMMAND,
  { name: "/cd", summary: "Alias for /new <path>", usage: "/cd <directory>" },
  { name: "/resume", summary: "Open a prior session (no implicit resume)" },
  { name: "/worktree", summary: "Switch a Trevor-managed worktree" },
] as const;
