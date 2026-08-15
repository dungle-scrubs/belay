import {
  isManifestSectionId,
  isPromptScope,
  MANIFEST_SCOPES,
  type ManifestExportRequest,
  type ManifestScope,
  type ManifestSectionId,
  renderManifestExport,
} from "@belay/session";
import type { Command } from "@host/commands/commands";
import { currentManifest } from "./source";

/**
 * The host-owned `/belay-export` command (plan 14, M6, D-002). It exposes the capability manifest in
 * bounded human + JSON forms - full, compact, section-scoped, and expert-scoped - reading the live manifest
 * through the {@link currentManifest} seam and formatting with the shared, redaction-applying renderer. The
 * arg parser is pure and unit-tested; the command is a thin shell over it, so the surface stays small.
 *
 * It is READ-ONLY: it composes and prints a description of the host's capabilities and changes nothing.
 *
 * Responsible for: parsing /belay-export args and shelling the parsed plan into a rendered
 * manifest export.
 * Not for: composing or redacting the manifest - build.ts and the shared renderer own that.
 */

/** A parsed export invocation: the scope to build at and the render request. */
export interface ManifestExportPlan {
  readonly scope: ManifestScope;
  readonly request: ManifestExportRequest;
}

export type ParseResult =
  | { readonly ok: true; readonly plan: ManifestExportPlan }
  | { readonly ok: false; readonly error: string };

/**
 * Parses `/belay-export` args into a plan. Flags: `--json` (machine JSON), `--compact` / `--expert`
 * (budgeted prompt block at that scope), `--full` (default human text), `--section <id>` (one section),
 * `--scope <scope>` (explicit scope override). Unknown flags / bad ids return an explicit error.
 */
export function parseExportArgs(args: string): ParseResult {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let format: ManifestExportRequest["format"] = "text";
  let detail: ManifestExportRequest["detail"] = "full";
  let scope: ManifestScope = "human";
  let scopeExplicit = false;
  let section: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token) {
      case "--json":
        format = "json";
        break;
      case "--full":
        detail = "full";
        break;
      case "--compact":
        detail = "compact";
        if (!scopeExplicit) {
          scope = "compact";
        }
        break;
      case "--expert":
        detail = "compact";
        if (!scopeExplicit) {
          scope = "expert";
        }
        break;
      case "--section": {
        const id = tokens[++i];
        if (!id || !isManifestSectionId(id)) {
          return {
            ok: false,
            error: `--section needs a valid section id (got ${id ?? "nothing"})`,
          };
        }
        section = id;
        break;
      }
      case "--scope": {
        const s = tokens[++i];
        if (!s || !MANIFEST_SCOPES.includes(s as ManifestScope)) {
          return { ok: false, error: `--scope needs one of: ${MANIFEST_SCOPES.join(", ")}` };
        }
        scope = s as ManifestScope;
        scopeExplicit = true;
        break;
      }
      default:
        return { ok: false, error: `unknown flag ${token} - see usage` };
    }
  }
  // A compact text render requires a prompt scope; a human/client + --compact combination is incoherent.
  if (format === "text" && detail === "compact" && !isPromptScope(scope)) {
    return { ok: false, error: "--compact requires a prompt scope (compact/subagent/expert)" };
  }
  return {
    ok: true,
    plan: {
      scope,
      request: { format, detail, ...(section ? { section: section as ManifestSectionId } : {}) },
    },
  };
}

/** Builds the `/belay-export` command (read-only; composes + prints the capability manifest). */
export function buildTrevorExportCommand(): Command<void> {
  return {
    spec: {
      name: "/belay-export",
      summary: "Export this host's capability manifest",
      usage: "/belay-export [--json] [--compact | --expert] [--section <id>] [--scope <scope>]",
    },
    select: () => undefined,
    run: async (args) => {
      const parsed = parseExportArgs(args);
      if (!parsed.ok) {
        return { text: `belay-export: ${parsed.error}`, ok: false };
      }
      const manifest = await currentManifest(parsed.plan.scope);
      if (!manifest) {
        return {
          text: "belay-export: capability manifest is unavailable (no live host on this session)",
          ok: false,
        };
      }
      return { text: renderManifestExport(manifest, parsed.plan.request), ok: true };
    },
  };
}
