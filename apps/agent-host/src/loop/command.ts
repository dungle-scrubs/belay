import {
  classifyLoopCommand,
  LOOP_COMMAND_NAMES,
  LOOP_FAMILY,
  parseLoopCommand,
} from "@trevor/session";
import type { Command } from "../commands";

/**
 * The host-owned `/loop` command surface (plan 17, M1). `/loop` is a command FAMILY, not a text macro:
 * the host re-parses every explicit submission AUTHORITATIVELY over the SAME shared parser the web helper
 * previews with (D-001/D-002), so a headless client that can only send command text gets the same
 * structured, UI-neutral result - readiness, the parsed fields, missing parts, and diagnostics - with no
 * builder UI. Creation confirmation (M4), runner execution (M5), and controls (M6) build on this; here the
 * host validates the command text and returns a structured preview/acknowledgement.
 */

/** Renders a parsed `/loop` line into a stable, UI-neutral, structured text result (no rows/chips/colors). */
export function describeLoopParse(input: string): string {
  const routed = classifyLoopCommand(input);
  if (routed.action === "invalid") {
    return `Not a /loop command. Try: ${LOOP_FAMILY.examples[0]?.text ?? '/loop max 5 do "…"'}`;
  }
  if (routed.action === "list") {
    return "action: list - lists the active loops.";
  }
  if (routed.action !== "create") {
    // A control verb (stop/pause/resume/run-now/delete): the target id is required.
    return routed.loopId !== undefined
      ? `action: ${routed.action} - target loop ${routed.loopId}.`
      : `usage: /loop ${routed.action} <id>`;
  }

  const parse = parseLoopCommand(input);
  const set = parse.fields
    .filter((row) => !row.missing && row.value !== undefined)
    .map((row) => `${row.label}: ${row.value}`)
    .join(", ");
  if (parse.ready) {
    return `action: create - ready. ${set}.`;
  }
  const errors = parse.diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.message);
  const parts = [
    parse.missing.length > 0 ? `missing ${parse.missing.join(", ")}` : "",
    ...errors,
  ].filter((part) => part.length > 0);
  return `action: create - not ready (${parts.join("; ")}). ${set}`.trimEnd();
}

/**
 * The `/loop` and `/loops` command entries for the host registry. Both route explicit command text through
 * the shared parser; the registry strips the command NAME and passes the rest as `args`, so we reconstruct
 * the full line before parsing. UI-neutral by construction - the result is plain structured text.
 */
export function buildLoopCommands(): Command[] {
  const run =
    (name: string) =>
    (args: string): string =>
      describeLoopParse(`${name} ${args}`.trimEnd());
  return LOOP_COMMAND_NAMES.map((name) => ({
    spec: {
      name,
      summary: LOOP_FAMILY.summary,
      usage: `${name} <action…>`,
    },
    select: () => undefined,
    run: run(name),
  }));
}
