/**
 * The docs tool's injectable dependency seam and its readiness gate. The whole docs path reads the
 * network only through the WebFetchReader/WebSearchReader seams and the filesystem only through
 * DocsFs, so every action is deterministic under test. The gate names the required dependencies that
 * are not ready, so the tool entry can resolve a missing one to a typed `unavailable` outcome rather
 * than throwing the turn.
 *
 * Responsible for: the DocsDeps/ReadyDocsDeps dependency seam and the missing-dependency gate.
 * Not for: constructing the live dependencies - docs.ts binds those.
 */

import type { DocsFs } from "./corpus-store";
import type { WebFetchReader, WebSearchReader } from "./readers";

/** Injectable dependencies, so the whole docs path is deterministic under test. */
export interface DocsDeps {
  readonly webFetch?: WebFetchReader;
  readonly webSearch?: WebSearchReader;
  /** The absolute docs-corpus root, or null when the root policy cannot classify it. */
  readonly corpusRoot: string | null;
  readonly fs: DocsFs;
  readonly now: () => string;
}

/** `DocsDeps` after the dependency gate has passed: web_fetch and the corpus root are guaranteed. */
export interface ReadyDocsDeps {
  readonly webFetch: WebFetchReader;
  readonly webSearch?: WebSearchReader;
  readonly corpusRoot: string;
  readonly fs: DocsFs;
  readonly now: () => string;
}

/** The required dependencies that are not ready, in stable order; empty means the gate passes. */
export function missingDependencies(deps: DocsDeps): readonly string[] {
  const missing: string[] = [];

  if (!deps.webFetch) {
    missing.push("web_fetch");
  }

  if (deps.corpusRoot === null) {
    missing.push("docs corpus root");
  }

  return missing;
}
