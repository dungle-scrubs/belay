import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { collectMarkdownFiles, parseFrontmatter, trimStr } from "@host/boot/manifest-discovery";
import { TREVOR_HOME, WORKSPACE_ROOT } from "@host/boot/paths";
import { msg } from "@host/transport/messages";
import type { CommandFile, CommandFileRootKind } from "./command-file";

/**
 * The `.trevor/commands/*.md` disk loader (plan 44.5, M3). It turns a markdown command file into the
 * plan-40 {@link CommandFile} primitive - `id` (`/<basename>`), `rootKind` (trust provenance), and the
 * frontmatter-stripped `body` - across an ORDERED list of trusted roots, project-local first. A project
 * command overrides a same-named user command (D-006). Loading is fail-soft: an unreadable or
 * empty-bodied file is skipped with a structured diagnostic, never a crash, so one bad file cannot break
 * command registration.
 *
 * The scan reuses `boot/manifest-discovery.ts` for both the recursive `.md` walk
 * (`collectMarkdownFiles`, shared with `project-context/rules.ts`) and the frontmatter strip, rather
 * than inventing a bespoke walker. The loaded bodies are handed to the plan-40 `expandCommandFile`
 * (interpolation) and then the `@trevor/session` `expandArgs` (substitution) at dispatch - this module
 * does neither; it only reads disk + assigns trust.
 *
 * Responsible for: discovering + reading command files across the project/user roots, id + trust-root
 * assignment, project-over-user precedence, and fail-soft diagnostics.
 * Not for: interpolation (command-file.ts), argument substitution (@trevor/session/command-args), or
 * registering/dispatching the command (commands.ts / main.ts).
 */

/** One command-file root to search, tagged with the trust/provenance kind its files inherit. Only the
 *  trusted `project`/`user` roots are searched (both operator-controlled, never downloaded content). */
export interface CommandFileRoot {
  readonly kind: Extract<CommandFileRootKind, "project" | "user">;
  readonly dir: string;
}

/**
 * A loaded command file: the {@link CommandFile} primitive plus the presentation metadata the web menu
 * needs. `summary` comes from the frontmatter `description`/`summary` (else a generic default);
 * `argumentHint` from the frontmatter `argument-hint` when present (populates `CommandSpec.argumentHint`).
 */
export interface LoadedCommandFile extends CommandFile {
  readonly summary: string;
  readonly argumentHint?: string;
}

/** Why one command file failed to load - a bounded, low-cardinality reason kept for a "why didn't my
 *  command load?" answer at the registration boundary. Never carries the file's contents. */
export interface CommandLoadDiagnostic {
  readonly code: "unreadable" | "empty";
  readonly message: string;
  readonly path: string;
  readonly severity: "warn" | "info";
}

/** The loader's result: the loaded command files (highest-precedence wins per id) plus any skip diagnostics. */
export interface CommandFileLoad {
  readonly files: readonly LoadedCommandFile[];
  readonly diagnostics: readonly CommandLoadDiagnostic[];
}

/** The project-local command root: `<workspace>/.trevor/commands`, the same workspace authority the
 *  file tools and `.trevor/rules` use. */
export const PROJECT_COMMANDS_DIR = resolve(WORKSPACE_ROOT, ".trevor", "commands");

/** The user-global command root: `<TREVOR_HOME>/commands`, beside the other config-home files. */
export const USER_COMMANDS_DIR = resolve(TREVOR_HOME, "commands");

/**
 * The ordered command-file roots, highest precedence FIRST: the project-local `.trevor/commands`, then
 * the user config-home `commands`. Deduplicated by resolved dir, so a root is never searched twice.
 */
export function commandFileRoots(): CommandFileRoot[] {
  const roots: CommandFileRoot[] = [{ kind: "project", dir: PROJECT_COMMANDS_DIR }];
  if (USER_COMMANDS_DIR !== PROJECT_COMMANDS_DIR) {
    roots.push({ kind: "user", dir: USER_COMMANDS_DIR });
  }
  return roots;
}

/** Frontmatter string fields treated as absent when blank: a `description:` with an empty/whitespace
 *  value must fall through to the next source (or the generic default), not surface as a blank summary. */
const nonEmpty = (value: unknown): string | undefined => trimStr(value) || undefined;

/**
 * Loads every command file across the ordered roots, project-local first. Each file's id is
 * `/<basename>` (no path, no extension); a command id is claimed by the FIRST root that loads it
 * successfully, so a project file overrides a same-named user file (D-006) and a shadowed same-id file
 * is skipped. An unreadable or empty-bodied file is skipped with a {@link CommandLoadDiagnostic} rather
 * than aborting the whole load. Pure over the passed roots, so precedence + fail-soft are unit-tested
 * with temp dirs.
 */
export function loadCommandFilesFrom(roots: readonly CommandFileRoot[]): CommandFileLoad {
  const files: LoadedCommandFile[] = [];
  const diagnostics: CommandLoadDiagnostic[] = [];
  const claimed = new Set<string>();

  for (const root of roots) {
    for (const path of collectMarkdownFiles(root.dir)) {
      const id = `/${basename(path, ".md")}`;
      // A higher-precedence root already defined this command - later roots (and same-id duplicates
      // within a root) are shadowed. Only a SUCCESSFUL load claims the id, so a broken project file
      // still lets the user file of that id surface.
      if (claimed.has(id)) {
        continue;
      }

      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (error) {
        diagnostics.push({
          code: "unreadable",
          message: `cannot read command file: ${msg(error)}`,
          path,
          severity: "warn",
        });
        continue;
      }

      const { data, body } = parseFrontmatter(raw);
      const trimmed = body.trim();
      if (!trimmed) {
        diagnostics.push({
          code: "empty",
          message: "command file has no body after frontmatter",
          path,
          severity: "info",
        });
        continue;
      }

      claimed.add(id);
      const argumentHint = nonEmpty(data["argument-hint"]) ?? nonEmpty(data.argumentHint);
      files.push({
        id,
        rootKind: root.kind,
        body: trimmed,
        summary: nonEmpty(data.description) ?? nonEmpty(data.summary) ?? `Custom command ${id}`,
        ...(argumentHint !== undefined ? { argumentHint } : {}),
      });
    }
  }

  return { files, diagnostics };
}

/** Loads command files across the effective roots ({@link commandFileRoots}); the host's entry point. */
export function loadCommandFiles(): CommandFileLoad {
  return loadCommandFilesFrom(commandFileRoots());
}
