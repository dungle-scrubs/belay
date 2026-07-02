/**
 * Locating cached corpora on disk WITHOUT any network: the build spec resolve/refresh derive from
 * their args, the corpus-id prediction an explicit URL makes possible, the by-subject inventory scan,
 * and the shared loaders - `loadExisting` for the build actions (reuse a fresh corpus before any
 * discovery runs) and `locateCorpus` for the query actions (target a cached corpus). Reads the
 * filesystem only.
 *
 * Responsible for: locating + loading cached corpora (id prediction, by-subject scan) and the
 * BuildSpec the actions derive from their args.
 * Not for: building corpora - build-actions.ts owns discovery/fetch/persist.
 */

import { corpusIdFor, hostOf } from "./corpus";
import { type CorpusStore, createCorpusStore, type LoadResult } from "./corpus-store";
import type { ReadyDocsDeps } from "./deps";
import {
  clamp,
  DEFAULT_MAX_PAGES,
  type DocsArgs,
  MAX_PAGES_CEILING,
  MAX_PAGES_FLOOR,
} from "./params";

/** The corpus-shaping inputs both resolve and refresh feed into the build pipeline. */
export interface BuildSpec {
  readonly subject?: string;
  readonly url?: string;
  readonly version?: string;
  readonly maxPages: number;
}

export function specFrom(args: DocsArgs): BuildSpec {
  return {
    ...(args.subject?.trim() ? { subject: args.subject.trim() } : {}),
    ...(args.url?.trim() ? { url: args.url.trim() } : {}),
    ...(args.version?.trim() ? { version: args.version.trim() } : {}),
    maxPages: clamp(args.maxPages, MAX_PAGES_FLOOR, MAX_PAGES_CEILING, DEFAULT_MAX_PAGES),
  };
}

/** A corpus that loaded cleanly off disk: the manifest, its pages, and any load diagnostics. */
export type LoadedCorpus = Extract<LoadResult, { state: "loaded" }>;

/**
 * Predicts the corpus id a build of `spec` would target WITHOUT any network, so a fresh corpus can be
 * reused before discovery runs. This is possible only when an explicit URL is given (the root is the
 * URL and the subject defaults to its host); a subject-only request needs a web_search to find the
 * root, so it falls back to a by-subject scan instead.
 */
function predictCorpusId(spec: BuildSpec): string | undefined {
  if (!spec.url) {
    return undefined;
  }

  const host = hostOf(spec.url);

  if (host === "") {
    return undefined;
  }

  return corpusIdFor({
    subject: spec.subject ?? host,
    rootUrl: spec.url,
    ...(spec.version ? { version: spec.version } : {}),
  });
}

/** Finds a cached corpus id by subject (and version, exactly), scanning the on-disk inventory. */
async function findBySubject(
  store: CorpusStore,
  subject: string,
  version: string | undefined,
): Promise<string | undefined> {
  const target = subject.trim().toLowerCase();
  const wantVersion = (version ?? "").trim().toLowerCase();

  for (const summary of await store.listCorpora()) {
    if (
      summary.subject.trim().toLowerCase() === target &&
      (summary.version ?? "").toLowerCase() === wantVersion
    ) {
      return summary.corpusId;
    }
  }

  return undefined;
}

/**
 * Loads an already-cached corpus matching `spec` without any network: by the predicted id when the
 * URL makes it derivable, otherwise by a by-subject scan. Reads the filesystem only.
 */
export async function loadExisting(
  spec: BuildSpec,
  deps: ReadyDocsDeps,
): Promise<LoadedCorpus | undefined> {
  const store = createCorpusStore(deps.fs, deps.corpusRoot);
  const predicted = predictCorpusId(spec);

  if (predicted) {
    const loaded = await store.loadCorpus(predicted);

    if (loaded.state === "loaded") {
      return loaded;
    }
  }

  if (spec.subject) {
    const found = await findBySubject(store, spec.subject, spec.version);

    if (found) {
      const loaded = await store.loadCorpus(found);

      if (loaded.state === "loaded") {
        return loaded;
      }
    }
  }

  return undefined;
}

/** A short reference for an action's error detail when no corpus could be located. */
export function targetRef(args: DocsArgs): string {
  return args.corpusId ?? args.subject?.trim() ?? args.url?.trim() ?? "(none)";
}

/**
 * Locates a cached corpus for a query action: by explicit corpusId, else by the predicted id or a
 * by-subject scan. Reads the filesystem only - query actions never touch the network.
 */
export async function locateCorpus(args: DocsArgs, deps: ReadyDocsDeps): Promise<LoadResult> {
  const store = createCorpusStore(deps.fs, deps.corpusRoot);

  if (args.corpusId) {
    return store.loadCorpus(args.corpusId);
  }

  const spec = specFrom(args);
  const predicted = predictCorpusId(spec);

  if (predicted) {
    const loaded = await store.loadCorpus(predicted);

    if (loaded.state !== "missing") {
      return loaded;
    }
  }

  if (spec.subject) {
    const found = await findBySubject(store, spec.subject, spec.version);

    if (found) {
      return store.loadCorpus(found);
    }
  }

  return { state: "missing" };
}
