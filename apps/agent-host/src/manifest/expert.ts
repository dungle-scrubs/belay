import {
  type ManifestExportRequest,
  type ManifestScope,
  type ManifestSectionId,
  orderSections,
} from "@trevor/session";
import { expertManifestExport } from "./expert-access";

/**
 * The built-in `trevor-expert` QUERY ORCHESTRATION (plan 14, M8/M9). trevor-expert explains THIS host from
 * its own deterministic capability exports: given a question, it routes to the few relevant sections, loads
 * ONLY those export slices on demand (never the whole manifest, never every prompt), and composes a bounded
 * answer with provenance and explicit unknown/unavailable states.
 *
 * It is deliberately SEPARATE from manifest generation (M8/M9 REFACTOR): this module decides WHICH slices a
 * question needs and how to present them; the builder decides what a section contains. And it reads through
 * the gate-independent {@link expertManifestExport} (D-004), so it works whether or not general
 * interpolation is enabled. It is read-only end to end: it never mutates state, grants a permission, or
 * starts work - it composes a description slice and returns it.
 */

/** The model-facing tool name (its def is the discovery metadata - discoverable, but not dumped). */
export const TREVOR_EXPERT_NAME = "trevor_expert";

/** The discovery description: what it does + when to reach for it (the trigger the model keys off). */
export const TREVOR_EXPERT_DESCRIPTION =
  "Answer questions about THIS Trevor host's own capabilities - its tools, slash commands, output styles, " +
  "skills, agents, model providers/catalog, doctor health, protocol/version, and workspace - from the live, " +
  "host-generated capability manifest. Use this when asked what Trevor can do, which tools/commands/skills " +
  "exist, what models are available, or how a built-in feature works. Read-only; it never changes anything.";

/** The max sections a single expert answer loads - keeps every answer bounded. */
export const MAX_EXPERT_SECTIONS = 4;

interface Route {
  readonly keywords: readonly string[];
  readonly sections: readonly ManifestSectionId[];
}

/** Question keyword -> section routing. First matches win; order here is priority, not output order. */
const ROUTES: readonly Route[] = [
  {
    keywords: ["provider", "model", "catalog", "source", "quant", "lm studio", "llm"],
    sections: ["catalog"],
  },
  {
    keywords: ["slash command", "command", "/help", "slash"],
    sections: ["commands", "commandFamilies"],
  },
  { keywords: ["output style", "style"], sections: ["styles"] },
  { keywords: ["skill"], sections: ["skills"] },
  { keywords: ["subagent", "agent", "delegate"], sections: ["agents"] },
  { keywords: ["mcp"], sections: ["mcp"] },
  { keywords: ["lsp", "language server"], sections: ["lsp"] },
  { keywords: ["hook"], sections: ["hooks"] },
  { keywords: ["doctor", "health", "diagnos"], sections: ["doctor"] },
  { keywords: ["docs corpus", "documentation", "docs"], sections: ["docs"] },
  { keywords: ["protocol", "version", "schema"], sections: ["protocol"] },
  { keywords: ["runtime", "role", "leader", "uptime"], sections: ["runtime"] },
  { keywords: ["workspace", "project", "branch", "cwd", "directory"], sections: ["workspace"] },
  { keywords: ["tool"], sections: ["tools"] },
];

/** The small default overview for a question that matches no route. */
const DEFAULT_SECTIONS: readonly ManifestSectionId[] = ["commands", "tools"];

/**
 * Routes a question to the bounded set of section ids it needs. Matches keyword routes (deduped, canonical
 * order), falls back to a small core overview when nothing matches, and never returns more than
 * {@link MAX_EXPERT_SECTIONS} - so an expert answer can never balloon into a full-manifest dump.
 */
export function selectExpertSections(question: string): ManifestSectionId[] {
  const q = question.toLowerCase();
  const matched = new Set<ManifestSectionId>();
  for (const route of ROUTES) {
    if (route.keywords.some((kw) => q.includes(kw))) {
      for (const section of route.sections) {
        matched.add(section);
      }
    }
  }
  const chosen = matched.size > 0 ? [...matched] : [...DEFAULT_SECTIONS];
  const ordered = orderSections(chosen.map((id) => ({ id }))).map((s) => s.id);
  return ordered.slice(0, MAX_EXPERT_SECTIONS);
}

/** The loader signature (injectable for tests); defaults to the gate-independent direct export access. */
export type ExpertLoad = (
  scope: ManifestScope,
  request: ManifestExportRequest,
) => Promise<string | null>;

export interface ExpertQueryOptions {
  readonly load?: ExpertLoad;
}

/**
 * Answers a question about the host by loading only the routed section slices (expert scope, section-scoped,
 * human-readable) and composing them with provenance. Returns an explicit "unavailable" answer when there is
 * no live manifest to read. Read-only: it loads descriptions, it never acts.
 */
export async function answerExpertQuery(
  question: string,
  options: ExpertQueryOptions = {},
): Promise<string> {
  const load = options.load ?? expertManifestExport;
  const sections = selectExpertSections(question);
  const slices = await Promise.all(
    sections.map(async (section) => {
      const text = await load("expert", { format: "text", detail: "full", section });
      return { section, text };
    }),
  );
  // A null from the very first load means no live host - report it once, plainly.
  if (slices.every((s) => s.text === null)) {
    return "trevor-expert: the capability manifest is unavailable (no live host on this session).";
  }
  const body = slices.map((s) => s.text ?? `## ${s.section}: unavailable`).join("\n\n");
  return `trevor-expert (from the live capability manifest):\n\n${body}`;
}
