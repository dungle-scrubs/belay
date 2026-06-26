/**
 * `/doctor` command-variant parsing (D-073 M1).
 *
 * One terse arg string selects how the health surface is produced: a VIEW (the structured `summary`
 * the web renders as a dashboard, a `full` detail view, raw `json`, or the legacy plain `text` dump),
 * plus two orthogonal flags - `refresh` (force a fresh probe instead of reusing cached state) and
 * `copy` (render a copyable report). Pure + lenient: tokens combine in any order, the last view token
 * wins, and an unrecognised token is ignored rather than rejected, so the command never errors on a
 * typo. The host routes `text` to the plaintext dump and everything else to the structured snapshot;
 * the web honours `view`/`copy` when rendering.
 */

/** The doctor output view. `summary` is the default structured dashboard payload. */
export type DoctorView = "summary" | "full" | "json" | "text";

/** A parsed `/doctor` invocation: the selected view plus the refresh/copy action flags. */
export interface DoctorCommand {
  readonly view: DoctorView;
  readonly refresh: boolean;
  readonly copy: boolean;
}

/** Token → view aliases (so `detail`/`details` mean `full`, `plain` means `text`). */
const VIEW_TOKENS: Readonly<Record<string, DoctorView>> = {
  summary: "summary",
  full: "full",
  detail: "full",
  details: "full",
  json: "json",
  text: "text",
  plain: "text",
};

/** Parses a `/doctor` arg string into a {@link DoctorCommand} (lenient; unknown tokens are ignored). */
export function parseDoctorCommand(args: string): DoctorCommand {
  const tokens = args.toLowerCase().split(/\s+/).filter(Boolean);
  let view: DoctorView = "summary";
  let refresh = false;
  let copy = false;
  for (const token of tokens) {
    if (token === "refresh" || token === "recheck") {
      refresh = true;
      continue;
    }
    if (token === "copy") {
      copy = true;
      continue;
    }
    const mapped = VIEW_TOKENS[token];
    if (mapped) {
      view = mapped; // a later view token wins
    }
  }
  return { view, refresh, copy };
}
