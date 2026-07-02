import { stripMatchingQuotes } from "@host/boot/args";
import type { HandoffMode } from "@trevor/session";

/**
 * The `/handoff` argument parser (M1), kept as a pure function separate from the host orchestration in
 * main.ts (which ensures the target session, injects the prompt, and switches). It maps the raw command
 * text after `/handoff` to a mode + prompt:
 *
 *   /handoff                 -> generate, no request (the model summarizes the current session)
 *   /handoff <text>          -> generate, with <text> as the generation request
 *   /handoff --generate <t>  -> generate, explicit
 *   /handoff --direct <t>    -> direct, <t> is the target prompt verbatim (empty is invalid: M2 rejects)
 *
 * A surrounding pair of matching quotes around the prompt is stripped, so a shell-style quoted argument
 * (`--direct "do the thing"`) yields the inner text.
 *
 * Responsible for: parsing `/handoff` arguments to a mode + prompt.
 * Not for: running the handoff - handoff-flow.ts (wired by main.ts).
 */

export interface ParsedHandoff {
  readonly mode: HandoffMode;
  /** The target prompt (direct) or the generation request (generate); may be empty. */
  readonly prompt: string;
}

const DIRECT = /^--direct(?:\s|$)/;
const GENERATE = /^--generate(?:\s|$)/;

export function parseHandoff(args: string): ParsedHandoff {
  const trimmed = args.trim();
  if (DIRECT.test(trimmed)) {
    return { mode: "direct", prompt: stripMatchingQuotes(trimmed.replace(DIRECT, "").trim()) };
  }
  if (GENERATE.test(trimmed)) {
    return { mode: "generate", prompt: stripMatchingQuotes(trimmed.replace(GENERATE, "").trim()) };
  }
  return { mode: "generate", prompt: stripMatchingQuotes(trimmed) };
}
