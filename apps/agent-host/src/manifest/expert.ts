import {
  type CapabilityManifest,
  type ManifestScope,
  type ManifestSectionId,
  orderSections,
  renderManifestSections,
} from "@trevor/session";
import { currentManifest } from "./source";

/**
 * The built-in `trevor-expert` QUERY ORCHESTRATION (plan 14, M8/M9). trevor-expert explains THIS host from
 * its own deterministic capability manifest: given a question, it reads the manifest ON DEMAND (never dumped
 * into every prompt), routes to the few relevant sections, and RENDERS only those - a bounded answer with
 * provenance and explicit unknown/unavailable states.
 *
 * It is deliberately SEPARATE from manifest generation (M8/M9 REFACTOR): this module decides WHICH sections
 * a question needs and how to present them; the builder decides what a section contains. And it reads the
 * manifest through the gate-independent {@link currentManifest} host seam (D-004), so it works whether or
 * not general interpolation is enabled. It is read-only end to end: it never mutates state, grants a
 * permission, or starts work - it reads a description and renders it.
 *
 * Responsible for: routing a trevor-expert question to a bounded set of manifest sections and
 * rendering the answer from the live manifest.
 * Not for: composing the manifest itself - build.ts and the ./source seam own that.
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

/** Footer listing the areas trevor-expert can answer about, so an unrouted/unknown topic gets an explicit
 *  pointer instead of a fabricated answer (M9: explicit unknown states). */
const EXPERT_AREAS_FOOTER =
  "Ask trevor-expert about: tools, commands, styles, skills, agents, mcp, lsp, hooks, docs, doctor, " +
  "providers/catalog, runtime, protocol, or workspace.";

/**
 * Routes a question to the bounded set of section ids it needs. Collects matches in ROUTE PRIORITY order
 * (ROUTES is ordered by priority), falls back to a small core overview when nothing matches, caps to
 * {@link MAX_EXPERT_SECTIONS} BY PRIORITY (so the highest-priority routes survive), then presents the
 * survivors in canonical order. An expert answer can never balloon into a full-manifest dump.
 */
export function selectExpertSections(question: string): ManifestSectionId[] {
  const q = question.toLowerCase();
  const matched: ManifestSectionId[] = [];
  const seen = new Set<ManifestSectionId>();
  for (const route of ROUTES) {
    if (route.keywords.some((kw) => q.includes(kw))) {
      for (const section of route.sections) {
        if (!seen.has(section)) {
          seen.add(section);
          matched.push(section);
        }
      }
    }
  }
  // Cap by priority FIRST (keep the highest-priority routes), then order canonically for display.
  const chosen = (matched.length > 0 ? matched : [...DEFAULT_SECTIONS]).slice(
    0,
    MAX_EXPERT_SECTIONS,
  );
  return orderSections(chosen.map((id) => ({ id }))).map((s) => s.id);
}

/** The manifest getter (injectable for tests); defaults to the gate-independent direct host read. */
export type ManifestGetter = (scope: ManifestScope) => Promise<CapabilityManifest | null>;

export interface ExpertQueryOptions {
  readonly getManifest?: ManifestGetter;
}

/**
 * Answers a question about the host by reading the manifest ONCE (expert scope, gate-independent - D-004),
 * then rendering ONLY the routed sections with provenance (a single coherent header, not one per section).
 * Returns an explicit "unavailable" answer when there is no live manifest. Read-only: it reads a
 * description and renders it, it never acts.
 */
export async function answerExpertQuery(
  question: string,
  options: ExpertQueryOptions = {},
): Promise<string> {
  const getManifest = options.getManifest ?? currentManifest;
  const manifest = await getManifest("expert");
  if (!manifest) {
    return "trevor-expert: the capability manifest is unavailable (no live host on this session).";
  }
  const body = renderManifestSections(manifest, selectExpertSections(question));
  return `trevor-expert (from the live capability manifest):\n\n${body}\n\n${EXPERT_AREAS_FOOTER}`;
}
