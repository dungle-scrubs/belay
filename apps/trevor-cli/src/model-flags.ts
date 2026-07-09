import type { CatalogSnapshot } from "@trevor/sdk";
import { type CatalogEntry, type ModelRef, queryCatalog } from "@trevor/session";

/**
 * CLI model catalog formatting and `--model` / `--reasoning` validation.
 *
 * Responsible for: terminal-facing model flag syntax, validation errors, and `trevor models` output.
 * Not for: probing providers or choosing host defaults, which stay host-owned.
 */

export class ModelFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelFlagError";
  }
}

function allEntries(catalog: CatalogSnapshot): readonly CatalogEntry[] {
  return Object.values(catalog.catalogBySource).flat();
}

function qualified(entry: Pick<CatalogEntry, "sourceId" | "modelId">): string {
  return `${entry.sourceId}/${entry.modelId}`;
}

function entryForQualified(
  catalog: CatalogSnapshot,
  sourceId: string,
  modelId: string,
): CatalogEntry | undefined {
  return catalog.catalogBySource[sourceId]?.find((entry) => entry.modelId === modelId);
}

function resolveEntry(catalog: CatalogSnapshot, rawModel: string): CatalogEntry {
  const [sourceId, ...modelParts] = rawModel.split("/");
  if (sourceId && modelParts.length > 0) {
    const modelId = modelParts.join("/");
    const entry = entryForQualified(catalog, sourceId, modelId);
    if (!entry) {
      throw new ModelFlagError(`unknown model ${rawModel}; run \`trevor models\` to list models`);
    }
    return entry;
  }

  const matches = allEntries(catalog).filter((entry) => entry.modelId === rawModel);
  if (matches.length === 1 && matches[0]) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new ModelFlagError(
      `ambiguous model ${rawModel}; use one of ${matches.map(qualified).join(", ")}`,
    );
  }
  throw new ModelFlagError(`unknown model ${rawModel}; run \`trevor models\` to list models`);
}

export function resolveModelRef(
  catalog: CatalogSnapshot,
  input: { readonly model?: string; readonly reasoning?: string },
): ModelRef | undefined {
  if (!input.model) {
    if (input.reasoning) {
      throw new ModelFlagError("reasoning requires a model; run `trevor models` to list models");
    }
    return undefined;
  }
  const entry = resolveEntry(catalog, input.model);
  if (input.reasoning && !entry.reasoningLevels.includes(input.reasoning)) {
    throw new ModelFlagError(
      `${qualified(entry)} does not support reasoning ${input.reasoning}; supported: ${
        entry.reasoningLevels.length > 0 ? entry.reasoningLevels.join(", ") : "none"
      }`,
    );
  }
  return {
    sourceId: entry.sourceId,
    modelId: entry.modelId,
    reasoning: input.reasoning ?? null,
  };
}

export function formatCatalog(catalog: CatalogSnapshot, json: boolean): string {
  if (json) {
    return JSON.stringify(catalog, null, 2);
  }
  const page = queryCatalog(allEntries(catalog), { limit: 200 });
  if (page.total === 0) {
    return "(no models)";
  }
  const lines = page.entries.map((entry) => {
    const levels =
      entry.reasoningLevels.length > 0
        ? `${entry.reasoningLevels.join(", ")} (default ${entry.defaultReasoning})`
        : "none";
    return `${qualified(entry)}\treasoning: ${levels}`;
  });
  if (page.total > page.entries.length) {
    lines.push(`(${page.entries.length} of ${page.total} models shown)`);
  }
  return lines.join("\n");
}
