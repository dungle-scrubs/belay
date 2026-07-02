/**
 * A small, dependency-free BM25 lexical index built on demand over a set of `{ id, text }`
 * documents (D-044 M2). No embeddings in the first cut: recall ranks by Okapi BM25 term
 * overlap, which is deterministic, cheap, and fully unit-testable. The index is pure - it
 * holds no IO and is rebuilt per query from the (already filtered) corpus, so there is no
 * stale-index lifecycle to manage.
 *
 * Responsible for: the pure BM25 lexical index and shared tokenizer that recall search ranks with.
 */

/** Okapi BM25 term-saturation parameter (standard default). */
const K1 = 1.5;
/** Okapi BM25 length-normalization parameter (standard default). */
const B = 0.75;

/** Lowercase, split on non-word boundaries, drop single chars + pure noise - the shared tokenizer. */
export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9_]+/g);
  if (!matches) {
    return [];
  }
  return matches.filter((token) => token.length > 1);
}

interface Doc {
  readonly id: string;
  readonly length: number;
  readonly tf: ReadonlyMap<string, number>;
}

export interface Bm25Hit {
  readonly id: string;
  readonly score: number;
}

export interface Bm25Index {
  /** Ranks documents against the query, descending by score, capped at `limit`. Zero-score
   *  documents (no query term present) are never returned. */
  readonly search: (query: string, limit: number) => Bm25Hit[];
}

/** Builds a BM25 index over the given documents. Empty-text docs are indexed but never match. */
export function buildBm25Index(
  documents: readonly { readonly id: string; readonly text: string }[],
): Bm25Index {
  const docs: Doc[] = [];
  const df = new Map<string, number>();
  let totalLength = 0;

  for (const document of documents) {
    const tokens = tokenize(document.text);
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    for (const term of tf.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
    docs.push({ id: document.id, length: tokens.length, tf });
    totalLength += tokens.length;
  }

  const n = docs.length;
  const avgdl = n > 0 ? totalLength / n : 0;

  const idf = (term: string): number => {
    const freq = df.get(term) ?? 0;
    // Okapi idf with the +0.5 smoothing; floored at 0 so a term in (almost) every doc never
    // contributes a negative score that would push an otherwise-strong match below zero.
    return Math.max(0, Math.log(1 + (n - freq + 0.5) / (freq + 0.5)));
  };

  return {
    search: (query, limit) => {
      const terms = [...new Set(tokenize(query))];
      if (terms.length === 0 || n === 0) {
        return [];
      }

      const hits: Bm25Hit[] = [];
      for (const doc of docs) {
        let score = 0;
        for (const term of terms) {
          const tf = doc.tf.get(term);
          if (!tf) {
            continue;
          }
          const denom = tf + K1 * (1 - B + (B * doc.length) / (avgdl || 1));
          score += idf(term) * ((tf * (K1 + 1)) / denom);
        }
        if (score > 0) {
          hits.push({ id: doc.id, score });
        }
      }

      hits.sort((a, b) => b.score - a.score);
      return hits.slice(0, limit);
    },
  };
}
