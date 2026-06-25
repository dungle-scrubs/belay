/**
 * Command-family registry: the lookup the command menu uses to decide a typed
 * command opens a helper panel instead of just inserting text.
 *
 * Web-local for now. Each entry pairs a family descriptor with the parser that
 * drives its builder. Adding a family here is all the menu needs to start
 * offering its helper.
 */
import type { CommandFamilyDescriptor, CommandParseResult } from "./command-family";
import { LOOP_FAMILY } from "./loop";
import { parseLoopCommand } from "./loop-parser";

export interface CommandFamilyEntry {
  readonly descriptor: CommandFamilyDescriptor;
  /** Parse a full command line (incl. the leading name) into a preview. */
  readonly parse: (input: string) => CommandParseResult;
}

export const COMMAND_FAMILIES: readonly CommandFamilyEntry[] = [
  { descriptor: LOOP_FAMILY, parse: parseLoopCommand },
];

/** The family a command name opens a helper for, or `undefined` for plain commands. */
export function commandFamilyForName(name: string): CommandFamilyEntry | undefined {
  return COMMAND_FAMILIES.find((entry) => entry.descriptor.names.includes(name));
}
