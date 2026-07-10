import { ArrowUpRight } from "lucide-react";
import { toolActionLabelForTarget } from "@/action-label";
import { fmtBytes } from "@/derive";
import { MarkdownBody } from "./markdown-body";
import { prettyUrl, SourceUrl } from "./source";
import { StatusAwareToolRenderer } from "./status-aware-tool-renderer";
import type { ToolStatus } from "./tool-status";

/**
 * The docs result envelope the renderer reads, mirroring the host's `serializeDocsResult` wire form
 * (envelope.ts). Every field is optional because a streaming or malformed result is parsed
 * defensively, and each action populates only the payload it carries: resolve/refresh attach a
 * `corpus` plus preview `excerpts`, search nests its ranked excerpts under `query`, read attaches a
 * `page`, list attaches `corpora`, and status attaches `provenance`. `stale`/`partial` ride alongside
 * so the freshness state is never hidden.
 */
export interface DocsCorpus {
  corpusId?: string;
  subject?: string;
  rootUrl?: string;
  version?: string;
  pageCount?: number;
  byteCount?: number;
  partial?: boolean;
  /** Set only on a `list` entry: the corpus's freshness as of the listing instant. */
  stale?: boolean;
}

export interface DocsExcerpt {
  url?: string;
  title?: string;
  locator?: string;
  excerpt?: string;
}

export interface DocsPage {
  url?: string;
  title?: string;
  content?: string;
  backend?: string;
  provenance?: string;
}

export interface ParsedDocs {
  action?: string;
  outcome?: string;
  detail?: string;
  corpus?: DocsCorpus;
  corpora?: DocsCorpus[];
  /** The cited excerpts: resolve/refresh's preview, or search's ranked matches (flattened here). */
  excerpts?: DocsExcerpt[];
  /** The search query text (lifted from the envelope's `query.query`). */
  queryText?: string;
  page?: DocsPage;
  provenance?: string;
  stale?: boolean;
  partial?: boolean;
  diagnostics?: string[];
  /** A rendered error (a non-ok outcome, an "error:" line, or an unparseable body). */
  error?: string;
}

function asExcerpts(value: unknown): DocsExcerpt[] | undefined {
  return Array.isArray(value) ? (value as DocsExcerpt[]) : undefined;
}

/** The human-readable failure line for a non-ok outcome, naming any missing dependency. */
function outcomeError(parsed: Record<string, unknown>): string {
  const detail = typeof parsed.detail === "string" ? parsed.detail : "docs call failed";
  const missing = Array.isArray(parsed.missing) ? parsed.missing : [];
  return missing.length > 0 ? `${detail} (missing: ${missing.join(", ")})` : detail;
}

/**
 * Parses the docs tool output: the structured envelope on success, an "error: ..." line on a typed
 * input failure, null while the call is still running (no result yet). A non-ok outcome
 * (unavailable/corrupt/error/not-found) renders as an error message; a truncated/non-JSON body falls
 * back to a plain error display, matching web_fetch's defensive parse.
 */
export function parseDocsResult(raw: string | undefined): ParsedDocs | null {
  if (!raw) {
    return null;
  }

  if (raw.startsWith("error:")) {
    return { error: raw.replace(/^error:\s*/u, "") };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (typeof parsed.outcome === "string" && typeof parsed.action === "string") {
      if (parsed.outcome !== "ok") {
        return { action: parsed.action, outcome: parsed.outcome, error: outcomeError(parsed) };
      }

      const query = (parsed.query ?? {}) as Record<string, unknown>;

      return {
        action: parsed.action,
        outcome: parsed.outcome,
        detail: typeof parsed.detail === "string" ? parsed.detail : undefined,
        corpus: (parsed.corpus as DocsCorpus | undefined) ?? undefined,
        corpora: Array.isArray(parsed.corpora) ? (parsed.corpora as DocsCorpus[]) : undefined,
        excerpts: asExcerpts(parsed.excerpts) ?? asExcerpts(query.excerpts),
        queryText: typeof query.query === "string" ? query.query : undefined,
        page: (parsed.page as DocsPage | undefined) ?? undefined,
        provenance: typeof parsed.provenance === "string" ? parsed.provenance : undefined,
        stale: parsed.stale === true,
        partial: (parsed.corpus as DocsCorpus | undefined)?.partial === true,
        diagnostics: Array.isArray(parsed.diagnostics)
          ? (parsed.diagnostics as string[])
          : undefined,
      };
    }
  } catch {
    // Truncated or non-JSON; fall through to a generic error display below.
  }

  return { error: raw };
}

/** A title link styled like web_search/web_fetch source rows, with the hover affordance arrow. */
function SourceLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group inline-flex items-center gap-1 text-sm font-medium text-foreground hover:text-smui-frost-3 hover:underline"
    >
      {label}
      <ArrowUpRight className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </a>
  );
}

/** The small amber freshness/partial chips, rendered only when the state is set. */
function StateBadges({ stale, partial }: { stale?: boolean; partial?: boolean }) {
  if (!stale && !partial) {
    return null;
  }

  return (
    <div className="flex items-center gap-1.5">
      {stale ? (
        <span className="text-label tracking-wider uppercase text-smui-yellow">stale</span>
      ) : null}
      {partial ? (
        <span className="text-label tracking-wider uppercase text-smui-orange">partial</span>
      ) : null}
    </div>
  );
}

/** The `subject · N pages · M KB` provenance line for a corpus summary. */
function corpusMeta(corpus: DocsCorpus): string {
  const pages =
    corpus.pageCount !== undefined
      ? `${corpus.pageCount} page${corpus.pageCount === 1 ? "" : "s"}`
      : undefined;
  return [pages, fmtBytes(corpus.byteCount)].filter(Boolean).join(" · ");
}

/** The corpus summary header: its documentation root link over the page/byte meta. */
function CorpusHeader({ corpus }: { corpus: DocsCorpus }) {
  const root = corpus.rootUrl;

  return (
    <div className="flex flex-col gap-0.5">
      {root ? (
        <SourceLink href={root} label={corpus.subject ?? prettyUrl(root)} />
      ) : (
        <span className="text-sm font-medium text-foreground">{corpus.subject ?? "Corpus"}</span>
      )}
      <div className="flex items-baseline gap-2">
        {root ? <SourceUrl url={root} /> : null}
        {corpusMeta(corpus) ? (
          <span className="text-label tracking-wider text-muted-foreground/70">
            {corpusMeta(corpus)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** One cited excerpt: its source link (title or URL) with locator, over the excerpt text. */
function ExcerptRow({ item }: { item: DocsExcerpt }) {
  const url = item.url ?? "";
  const label = item.title ?? (url ? prettyUrl(url) : "Excerpt");

  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-baseline gap-2">
        {url ? (
          <SourceLink href={url} label={label} />
        ) : (
          <span className="text-sm font-medium">{label}</span>
        )}
        {item.locator ? (
          <span className="shrink-0 text-label tracking-wider text-muted-foreground/70">
            {item.locator}
          </span>
        ) : null}
      </div>
      {item.excerpt ? <p className="text-sm text-muted-foreground">{item.excerpt}</p> : null}
    </li>
  );
}

/** One corpus inventory row for the `list` action: its root link, meta, and freshness chips. */
function CorpusRow({ corpus }: { corpus: DocsCorpus }) {
  const root = corpus.rootUrl;

  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-3">
        {root ? (
          <SourceLink href={root} label={corpus.subject ?? prettyUrl(root)} />
        ) : (
          <span className="text-sm font-medium text-foreground">{corpus.subject ?? "Corpus"}</span>
        )}
        <StateBadges stale={corpus.stale} partial={corpus.partial} />
      </div>
      <div className="flex items-baseline gap-2">
        {root ? <SourceUrl url={root} /> : null}
        {corpusMeta(corpus) ? (
          <span className="text-label tracking-wider text-muted-foreground/70">
            {corpusMeta(corpus)}
          </span>
        ) : null}
      </div>
    </li>
  );
}

interface DocsResultProps {
  /** A short label for the tool row (e.g. "resolve Effect Schema"). */
  args: string;
  /** The bare salient target (subject/query/url/corpusId, no action prefix), used ONLY for the
   *  running-state shimmer label so it doesn't double up on `args`'s own leading action word. */
  runningTarget?: string;
  parsed?: ParsedDocs | null;
  status?: ToolStatus;
  /** Whether the body starts expanded; the global compact setting drives this. */
  defaultOpen?: boolean;
  className?: string;
  /** Ms epoch of the tool's start; feeds the running row's live elapsed clock (58.6.1 M2). */
  startedAt?: number;
}

/**
 * Renders a `docs` tool call as STRUCTURED source-backed documentation: a corpus summary (its
 * documentation root, page/byte counts, and stale/partial chips), the ranked cited excerpts
 * (resolve/refresh preview or search matches, each a source link + locator + snippet), a bounded page
 * read, or the corpus inventory - plus a subdued provenance line and any diagnostics. Reuses the
 * web_search/web_fetch link styling and the shared StatusAwareToolRenderer (a working indicator while
 * running, a red message on a non-ok outcome), so the model's documentation output reads as cited
 * sources, never opaque JSON.
 */
export function DocsResult({
  args,
  runningTarget,
  parsed,
  status = "done",
  defaultOpen = true,
  className,
  startedAt,
}: DocsResultProps) {
  const corpus = parsed?.corpus;
  const excerpts = parsed?.excerpts ?? [];
  const corpora = parsed?.corpora ?? [];
  const page = parsed?.page;
  const diagnostics = parsed?.diagnostics ?? [];

  const body = (
    <div className="flex flex-col gap-2.5">
      {corpus ? (
        <div className="flex items-start justify-between gap-3">
          <CorpusHeader corpus={corpus} />
          <StateBadges stale={parsed?.stale} partial={parsed?.partial} />
        </div>
      ) : null}

      {parsed?.queryText ? (
        <span className="text-label tracking-wider text-muted-foreground/70">
          results for “{parsed.queryText}”
        </span>
      ) : null}

      {excerpts.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {excerpts.map((item, index) => (
            <ExcerptRow item={item} key={`${item.url ?? "x"}-${item.locator ?? index}`} />
          ))}
        </ol>
      ) : null}

      {page ? (
        <div className="flex flex-col gap-2">
          {page.url ? (
            <SourceLink href={page.url} label={page.title ?? prettyUrl(page.url)} />
          ) : null}
          {page.content ? (
            <MarkdownBody text={page.content} muted />
          ) : (
            <span className="text-sm italic text-muted-foreground">No content.</span>
          )}
          {page.provenance ? (
            <span className="text-label tracking-wider text-muted-foreground/70">
              {page.provenance}
            </span>
          ) : null}
        </div>
      ) : null}

      {corpora.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {corpora.map((entry) => (
            <CorpusRow corpus={entry} key={entry.corpusId ?? entry.rootUrl ?? entry.subject} />
          ))}
        </ol>
      ) : null}

      {!corpus && corpora.length === 0 && excerpts.length === 0 && !page && parsed?.detail ? (
        <span className="text-sm text-muted-foreground">{parsed.detail}</span>
      ) : null}

      {parsed?.provenance ? (
        <span className="text-label tracking-wider text-muted-foreground/70">
          {parsed.provenance}
        </span>
      ) : null}

      {diagnostics.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {diagnostics.map((line) => (
            <li className="text-xs text-muted-foreground/80" key={line}>
              {line}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  return (
    <StatusAwareToolRenderer
      name="docs"
      args={args}
      status={status}
      error={parsed?.error}
      running={status === "running" && !parsed}
      runningLabel={toolActionLabelForTarget("docs", runningTarget)}
      startedAt={startedAt}
      defaultOpen={defaultOpen}
      className={className}
      renderBody={() => body}
    />
  );
}
