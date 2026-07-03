/**
 * The docs corpus store: persists a corpus as inspectable JSON under the docs-corpus state root - a
 * directory per corpusId holding a `manifest.json` and a `pages/<pageId>.json` per page. Writes are
 * atomic-enough (temp file + rename) and the manifest carries a completeness flag written PARTIAL
 * first and finalized last, so an interrupted corpus loads as visibly partial rather than silently
 * healthy. A load recomputes each page's content hash and cross-checks the page count, so a corrupt
 * or truncated file surfaces as a diagnostic. Filesystem access goes through the injected `DocsFs`
 * seam, so tests run against a fake and never touch real disk.
 *
 * Responsible for: persisting and loading docs corpora as manifest + page JSON files, with
 * completeness flags and integrity checks on load.
 * Not for: corpus types and id derivation - corpus.ts.
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomicVia } from "@host/io/atomic-write";
import {
  type Corpus,
  type CorpusSummary,
  contentHash,
  DOCS_CORPUS_VERSION,
  type Page,
} from "./corpus";
import { corruptResult, type DocsAction, type DocsResult, errorResult } from "./envelope";

/** The minimal filesystem surface the store needs, injected so tests use an in-memory fake. */
export interface DocsFs {
  /** Creates a directory and any missing parents (idempotent). */
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
  readFile(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  /** Immediate child names of a directory; an empty array when it does not exist. */
  readdir(path: string): Promise<readonly string[]>;
  exists(path: string): Promise<boolean>;
  /** Removes a file or directory subtree (idempotent). */
  remove(path: string): Promise<void>;
}

/** The live `DocsFs`, backed by node:fs/promises. */
export const nodeDocsFs: DocsFs = {
  mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
  writeFile: (path, data) => writeFile(path, data, "utf8"),
  readFile: (path) => readFile(path, "utf8"),
  rename: (from, to) => rename(from, to),
  readdir: async (path) => {
    try {
      return await readdir(path);
    } catch {
      return [];
    }
  },
  exists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  remove: (path) => rm(path, { recursive: true, force: true }).then(() => undefined),
};

/** The outcome of loading a corpus by id - missing, corrupt beyond use, or loaded (possibly partial). */
export type LoadResult =
  | { readonly state: "missing" }
  | { readonly state: "corrupt"; readonly corpusId: string; readonly detail: string }
  | {
      readonly state: "loaded";
      readonly corpus: Corpus;
      readonly pages: readonly Page[];
      /** True when the manifest was left partial or a page failed its integrity check. */
      readonly partial: boolean;
      readonly diagnostics: readonly string[];
    };

export type LoadedCorpus = Extract<LoadResult, { state: "loaded" }>;

export function requireLoadedCorpus(
  action: DocsAction,
  loaded: LoadResult,
  ref: string,
): LoadedCorpus | DocsResult {
  if (loaded.state === "loaded") {
    return loaded;
  }

  if (loaded.state === "missing") {
    const detail =
      action === "read" || action === "refresh"
        ? `docs ${action}: corpus ${ref} not found`
        : `docs ${action}: no cached corpus for ${ref}${action === "search" ? "; resolve it first" : ""}`;
    return errorResult(action, detail);
  }

  return corruptResult(
    action,
    `docs ${action}: corpus ${loaded.corpusId} is corrupt: ${loaded.detail}`,
  );
}

/** Reads/writes corpora under one docs-corpus root through an injected filesystem. */
export interface CorpusStore {
  saveCorpus(corpus: Corpus, pages: readonly Page[]): Promise<void>;
  loadCorpus(corpusId: string): Promise<LoadResult>;
  listCorpora(): Promise<readonly CorpusSummary[]>;
  removeCorpus(corpusId: string): Promise<void>;
}

function corpusDir(root: string, corpusId: string): string {
  return join(root, corpusId);
}

function manifestPath(dir: string): string {
  return join(dir, "manifest.json");
}

function pagesDir(dir: string): string {
  return join(dir, "pages");
}

function pagePath(dir: string, pageId: string): string {
  return join(pagesDir(dir), `${pageId}.json`);
}

/** Writes JSON via the shared temp-write + rename helper, so a reader never observes a torn file. */
async function writeJsonAtomic(fs: DocsFs, path: string, value: unknown): Promise<void> {
  await writeFileAtomicVia(fs, path, `${JSON.stringify(value, null, 2)}\n`);
}

async function saveCorpusTo(
  fs: DocsFs,
  root: string,
  corpus: Corpus,
  pages: readonly Page[],
): Promise<void> {
  const dir = corpusDir(root, corpus.corpusId);

  await fs.mkdir(pagesDir(dir));
  // Mark the manifest PARTIAL before the pages land, so a crash mid-write leaves it visibly partial.
  await writeJsonAtomic(fs, manifestPath(dir), {
    ...corpus,
    version: DOCS_CORPUS_VERSION,
    partial: true,
  });

  for (const page of pages) {
    await writeJsonAtomic(fs, pagePath(dir, page.pageId), {
      ...page,
      version: DOCS_CORPUS_VERSION,
    });
  }

  // Finalize: the write is done, so the manifest's completeness flag now reflects the corpus's own
  // partial intent (a cap hit or a failed page read) rather than the in-flight-write window.
  await writeJsonAtomic(fs, manifestPath(dir), {
    ...corpus,
    version: DOCS_CORPUS_VERSION,
    partial: corpus.partial === true,
  });
}

async function loadCorpusFrom(fs: DocsFs, root: string, corpusId: string): Promise<LoadResult> {
  const dir = corpusDir(root, corpusId);
  const path = manifestPath(dir);

  if (!(await fs.exists(path))) {
    return { state: "missing" };
  }

  let manifest: Corpus;

  try {
    manifest = JSON.parse(await fs.readFile(path)) as Corpus;
  } catch {
    return { state: "corrupt", corpusId, detail: "manifest is not valid JSON" };
  }

  if (!manifest || typeof manifest !== "object" || manifest.corpusId !== corpusId) {
    return {
      state: "corrupt",
      corpusId,
      detail: "manifest is missing or has a mismatched corpusId",
    };
  }

  const diagnostics: string[] = [];
  let partial = manifest.partial === true;

  if (partial) {
    diagnostics.push("manifest marked partial: a prior write did not finish");
  }

  if (manifest.version !== DOCS_CORPUS_VERSION) {
    diagnostics.push(
      `manifest format version ${manifest.version} != expected ${DOCS_CORPUS_VERSION}`,
    );
  }

  const pages: Page[] = [];

  for (const file of await fs.readdir(pagesDir(dir))) {
    if (!file.endsWith(".json")) {
      continue;
    }

    let page: Page;

    try {
      page = JSON.parse(await fs.readFile(join(pagesDir(dir), file))) as Page;
    } catch {
      diagnostics.push(`page file ${file} is not valid JSON`);
      partial = true;
      continue;
    }

    if (contentHash(page.content) !== page.contentHash) {
      diagnostics.push(`page ${page.pageId} content hash mismatch (corrupt or truncated)`);
      partial = true;
    }

    pages.push(page);
  }

  if (manifest.pageCount !== pages.length) {
    diagnostics.push(
      `manifest pageCount ${manifest.pageCount} != ${pages.length} stored page files`,
    );
    partial = true;
  }

  return { state: "loaded", corpus: { ...manifest, partial }, pages, partial, diagnostics };
}

/** A compact projection of a corpus for listings and the resolve/status outcomes. */
export function summarizeCorpus(corpus: Corpus): CorpusSummary {
  return {
    corpusId: corpus.corpusId,
    subject: corpus.subject,
    rootUrl: corpus.source.rootUrl,
    ...(corpus.source.version !== undefined ? { version: corpus.source.version } : {}),
    pageCount: corpus.pageCount,
    byteCount: corpus.byteCount,
    updatedAt: corpus.updatedAt,
    staleAfter: corpus.staleAfter,
    partial: corpus.partial,
  };
}

async function listCorporaIn(fs: DocsFs, root: string): Promise<readonly CorpusSummary[]> {
  const summaries: CorpusSummary[] = [];

  for (const corpusId of await fs.readdir(root)) {
    const result = await loadCorpusFrom(fs, root, corpusId);

    if (result.state === "missing") {
      continue;
    }

    if (result.state === "corrupt") {
      summaries.push({
        corpusId,
        subject: "(corrupt)",
        rootUrl: "",
        pageCount: 0,
        byteCount: 0,
        updatedAt: "",
        staleAfter: "",
        partial: true,
      });
      continue;
    }

    summaries.push(summarizeCorpus(result.corpus));
  }

  return summaries;
}

/** Builds a corpus store rooted at one docs-corpus directory, reading/writing through `fs`. */
export function createCorpusStore(fs: DocsFs, root: string): CorpusStore {
  return {
    saveCorpus: (corpus, pages) => saveCorpusTo(fs, root, corpus, pages),
    loadCorpus: (corpusId) => loadCorpusFrom(fs, root, corpusId),
    listCorpora: () => listCorporaIn(fs, root),
    removeCorpus: (corpusId) => fs.remove(corpusDir(root, corpusId)),
  };
}
