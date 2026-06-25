/**
 * Destructive bash command classification - the deny-only safety floor behind
 * the bash tool. It splits a command on unquoted separators, strips
 * sudo/command/env and environment-assignment prefixes, reduces argv0 to its
 * basename, collapses whitespace, and expands `~`/`$HOME` before matching deny
 * classes: recursive force-deletes of protected roots, recursive permission
 * stomps, raw device writes/formats, fork bombs, download-piped-to-shell, and
 * find-based root deletion. This catches every spelling of `rm -rf <root>`
 * (-rf, -fr, -r -f, --recursive --force, -Rf, sudo/env-prefixed, ~/$HOME, ...)
 * rather than a naive substring.
 *
 * This is a BEST-EFFORT DEFENSE-IN-DEPTH FLOOR, not a sandbox: a determined
 * adversary can still evade normalization. It exists to stop accidents and lazy
 * disguises, and must never be advertised as containment.
 */
import { homedir } from "node:os";

export type BashSafetyOptions = {
  readonly workspaceRoot?: string;
  readonly home?: string;
};

const SYSTEM_TOP_LEVEL_DIRS = [
  "/Applications",
  "/Library",
  "/System",
  "/Users",
  "/bin",
  "/dev",
  "/etc",
  "/lib",
  "/opt",
  "/private",
  "/sbin",
  "/tmp",
  "/usr",
  "/var",
];

const SHELL_BASENAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const DOWNLOADER_BASENAMES = new Set(["curl", "wget", "fetch"]);

const DEFENSE_IN_DEPTH_NOTE = "best-effort defense-in-depth floor, not a sandbox";

type Segment = {
  readonly tokens: string[];
  /** Separator between this segment and the previous one. */
  readonly separatorBefore: "|" | "&&" | ";" | "&" | undefined;
};

function splitUnquotedSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let current = "";
  let separatorBefore: Segment["separatorBefore"];
  let quote: '"' | "'" | undefined;
  let index = 0;

  const push = (nextSeparator: Segment["separatorBefore"]) => {
    segments.push({ tokens: tokenize(current), separatorBefore });
    separatorBefore = nextSeparator;
    current = "";
  };

  while (index < command.length) {
    const char = command[index] as string;
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      current += char;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      index += 1;
      continue;
    }
    if (char === "\\") {
      current += command.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === "&" && command[index + 1] === "&") {
      push("&&");
      index += 2;
      continue;
    }
    if (char === "&") {
      push("&");
      index += 1;
      continue;
    }
    if (char === "|") {
      push("|");
      index += 1;
      continue;
    }
    if (char === ";") {
      push(";");
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  push(undefined);
  return segments.filter((segment) => segment.tokens.length > 0);
}

function tokenize(segment: string): string[] {
  return segment
    .split(/\s+/u)
    .map(stripQuotes)
    .filter((token) => token.length > 0);
}

function stripQuotes(token: string): string {
  if (
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const WRAPPER_COMMANDS = new Set(["sudo", "command", "env", "nohup", "time"]);

/** Drop env assignments and sudo/command/env-style wrappers from the front. */
function stripExecutionPrefixes(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] as string;
    if (ENV_ASSIGNMENT.test(token)) {
      index += 1;
      continue;
    }
    if (WRAPPER_COMMANDS.has(basename(token))) {
      index += 1;
      continue;
    }
    break;
  }
  return tokens.slice(index);
}

function basename(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash === -1 ? token : token.slice(slash + 1);
}

function normalizePath(token: string, home: string): string {
  let value = token;
  // biome-ignore lint/suspicious/noTemplateCurlyInString: matching the literal shell string ${HOME}, not a JS template.
  if (value === "~" || value === "$HOME" || value === "${HOME}") {
    value = home;
  } else if (value.startsWith("~/")) {
    value = home + value.slice(1);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matching the literal shell string ${HOME}/, not a JS template.
  } else if (value.startsWith("$HOME/") || value.startsWith("${HOME}/")) {
    value = home + value.slice(value.indexOf("/"));
  }
  while (value.length > 1 && value.endsWith("/")) {
    value = value.slice(0, -1);
  }
  return value;
}

function protectedRoots(options: BashSafetyOptions): Set<string> {
  const home = options.home ?? homedir();
  const roots = new Set<string>(["/", ".", "..", home, ...SYSTEM_TOP_LEVEL_DIRS]);
  if (options.workspaceRoot) {
    roots.add(normalizePath(options.workspaceRoot, home));
  }
  return roots;
}

function isProtectedTarget(normalized: string, roots: Set<string>): boolean {
  if (roots.has(normalized)) {
    return true;
  }
  // Any user's home directory root.
  return /^\/Users\/[^/]+$/u.test(normalized);
}

function isFlag(token: string): boolean {
  return token.startsWith("-");
}

function shortFlagsInclude(tokens: string[], letter: string): boolean {
  return tokens.some(
    (token) => /^-[A-Za-z]+$/u.test(token) && token.slice(1).toLowerCase().includes(letter),
  );
}

function classifySegment(
  rawTokens: string[],
  roots: Set<string>,
  home: string,
): string | undefined {
  const tokens = stripExecutionPrefixes(rawTokens);
  if (tokens.length === 0) {
    return undefined;
  }
  const argv0 = basename(tokens[0] as string);
  const args = tokens.slice(1);
  const targets = args.filter((token) => !isFlag(token)).map((token) => normalizePath(token, home));

  if (argv0 === "rm") {
    const recursive = shortFlagsInclude(args, "r") || args.includes("--recursive");
    const force = shortFlagsInclude(args, "f") || args.includes("--force");
    const protectedTarget = targets.find((target) => isProtectedTarget(target, roots));
    if (recursive && force && protectedTarget !== undefined) {
      return `recursive force delete targeting protected root "${protectedTarget}"`;
    }
  }

  if (argv0 === "chmod" || argv0 === "chown") {
    const recursive = shortFlagsInclude(args, "r") || args.includes("--recursive");
    // First non-flag arg is the mode/owner; the rest are targets.
    const protectedTarget = targets.slice(1).find((target) => isProtectedTarget(target, roots));
    if (recursive && protectedTarget !== undefined) {
      return `recursive ${argv0} on protected root "${protectedTarget}"`;
    }
  }

  if (argv0 === "dd") {
    const deviceWrite = args.find((token) => token.startsWith("of=/dev/"));
    if (deviceWrite) {
      return `raw device write (${deviceWrite})`;
    }
  }

  if (argv0.startsWith("mkfs")) {
    const device = args.find((token) => token.startsWith("/dev/"));
    if (device) {
      return `filesystem format of ${device}`;
    }
  }

  if (argv0 === "find") {
    const searchRoots = [];
    for (const token of args) {
      if (isFlag(token)) {
        break;
      }
      searchRoots.push(normalizePath(token, home));
    }
    const protectedTarget = searchRoots.find((target) => isProtectedTarget(target, roots));
    const deletes =
      args.includes("-delete") ||
      args.some((token, index) => token === "-exec" && basename(args[index + 1] ?? "") === "rm");
    if (protectedTarget !== undefined && deletes) {
      return `find-based deletion under protected root "${protectedTarget}"`;
    }
  }

  return undefined;
}

/**
 * Returns a human-readable reason if the command is always-prevented, or
 * undefined if it passes the floor. Deny-only: an undefined result is NOT a
 * safety guarantee, only the absence of a known-destructive pattern.
 */
export function classifyAlwaysPreventedBashCommand(
  command: string,
  options: BashSafetyOptions = {},
): string | undefined {
  const home = options.home ?? homedir();
  const roots = protectedRoots(options);

  // Fork bombs are detected on the raw command: the separator split below
  // would dismember the `:(){ :|:& };:` token sequence.
  if (command.replace(/\s+/gu, "").includes(":(){:|:&};:")) {
    return `fork bomb (${DEFENSE_IN_DEPTH_NOTE})`;
  }

  const segments = splitUnquotedSegments(command);
  for (const [index, segment] of segments.entries()) {
    const reason = classifySegment(segment.tokens, roots, home);
    if (reason) {
      return `${reason} (${DEFENSE_IN_DEPTH_NOTE})`;
    }

    // Download piped directly into a shell.
    const next = segments[index + 1];
    if (next && next.separatorBefore === "|") {
      const argv0 = basename(stripExecutionPrefixes(segment.tokens)[0] ?? "");
      const nextArgv0 = basename(stripExecutionPrefixes(next.tokens)[0] ?? "");
      if (DOWNLOADER_BASENAMES.has(argv0) && SHELL_BASENAMES.has(nextArgv0)) {
        return `download piped to shell (${DEFENSE_IN_DEPTH_NOTE})`;
      }
    }
  }
  return undefined;
}
