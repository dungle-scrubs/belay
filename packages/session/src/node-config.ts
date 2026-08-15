import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ParseError, parse } from "jsonc-parser";
import { resolveBelayHome } from "./node-paths";

/**
 * Node-only loader for Belay's editable `config.jsonc`.
 *
 * Responsible for: locating and parsing `<BELAY_HOME>/config.jsonc` with source diagnostics.
 * Not for: interpreting individual app keys or applying command-line precedence.
 */

export interface BelayConfigFile {
  readonly model?: string;
  readonly reasoning?: string;
}

export type ConfigValueSource = "flag" | "env" | "file" | "default";

export interface LoadedBelayConfig {
  readonly path: string;
  readonly config: BelayConfigFile;
  readonly warning: string | null;
}

export interface BelayConfigEnv extends Readonly<Record<string, string | undefined>> {
  readonly BELAY_HOME?: string;
}

function parseBelayConfig(raw: unknown): BelayConfigFile {
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

export function belayConfigPath(env: BelayConfigEnv = process.env): string {
  return join(resolveBelayHome(env), "config.jsonc");
}

export function loadBelayConfig(
  options: { readonly env?: BelayConfigEnv; readonly readFile?: (path: string) => string } = {},
): LoadedBelayConfig {
  const path = belayConfigPath(options.env);
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
  return { path, config: parseBelayConfig(parsed), warning: null };
}

/** @deprecated Use LoadedBelayConfig */
export type LoadedTrevorConfig = LoadedBelayConfig;
/** @deprecated Use loadBelayConfig */
export const loadTrevorConfig = loadBelayConfig;
/** @deprecated Use belayConfigPath */
export const trevorConfigPath = belayConfigPath;
