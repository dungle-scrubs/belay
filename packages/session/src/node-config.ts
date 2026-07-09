import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ParseError, parse } from "jsonc-parser";
import { resolveTrevorHome } from "./node-paths";

/**
 * Node-only loader for Trevor's editable `config.jsonc`.
 *
 * Responsible for: locating and parsing `<TREVOR_HOME>/config.jsonc` with source diagnostics.
 * Not for: interpreting individual app keys or applying command-line precedence.
 */

export interface TrevorConfigFile {
  readonly model?: string;
  readonly reasoning?: string;
}

export type ConfigValueSource = "flag" | "env" | "file" | "default";

export interface LoadedTrevorConfig {
  readonly path: string;
  readonly config: TrevorConfigFile;
  readonly warning: string | null;
}

export interface TrevorConfigEnv extends Readonly<Record<string, string | undefined>> {
  readonly TREVOR_HOME?: string;
}

function parseTrevorConfig(raw: unknown): TrevorConfigFile {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }
  const record = raw as Record<string, unknown>;
  return {
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(typeof record.reasoning === "string" ? { reasoning: record.reasoning } : {}),
  };
}

function parseErrorText(errors: readonly ParseError[]): string {
  return errors.map((error) => `error ${error.error} at offset ${error.offset}`).join(", ");
}

export function trevorConfigPath(env: TrevorConfigEnv = process.env): string {
  return join(resolveTrevorHome(env), "config.jsonc");
}

export function loadTrevorConfig(
  options: { readonly env?: TrevorConfigEnv; readonly readFile?: (path: string) => string } = {},
): LoadedTrevorConfig {
  const path = trevorConfigPath(options.env);
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let text: string;
  try {
    text = readFile(path);
  } catch {
    return { path, config: {}, warning: null };
  }
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    return {
      path,
      config: {},
      warning: `config.jsonc is malformed (${parseErrorText(errors)}); using env/defaults`,
    };
  }
  return { path, config: parseTrevorConfig(parsed), warning: null };
}
