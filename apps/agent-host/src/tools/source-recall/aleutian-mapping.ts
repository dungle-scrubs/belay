/**
 * Responsible for: the PURE mapping between Aleutian Trace's documented HTTP shapes
 * (`/v1/trace/*`: health, ready, tools, init, context, symbol, callers, references) and Belay's
 * normalized source-recall model. Aleutian is broader than a chunk search - it is a structural
 * call-graph + symbol + context engine - so capability discovery decides which normalized
 * capabilities it advertises, and a graph SymbolInfo / ReferenceInfo maps to the SAME
 * {@link SourceRecallResultItem} shape as a source-recall chunk, preserving provider-specific detail
 * (signature, package, kind) in `meta` for detail views (M5/M6).
 *
 * Not for: making requests (aleutian-adapter.ts) or the source-recall daemon shapes (source-recall-mapping.ts).
 */
import type {
  SourceRecallCapability,
  SourceRecallReadiness,
  SourceRecallResultItem,
} from "@belay/session";

/** `GET /v1/trace/health` body. */
export interface AlHealthBody {
  readonly status: string; // "healthy" | "degraded"
  readonly version?: string;
}

/** `GET /v1/trace/ready` body. */
export interface AlReadyBody {
  readonly ready: boolean;
  readonly graph_count: number;
  readonly weaviate_ok: boolean;
  readonly nats_ok?: boolean;
}

/** `GET /v1/trace/tools` body. */
export interface AlToolsBody {
  readonly tools: readonly { readonly name: string }[];
}

/** `POST /v1/trace/init` body. */
export interface AlInitBody {
  readonly graph_id: string;
  readonly is_refresh?: boolean;
  readonly files_parsed: number;
  readonly symbols_extracted: number;
  readonly edges_built?: number;
  readonly parse_time_ms?: number;
  readonly errors?: readonly string[];
}

/** `POST /v1/trace/context` body. */
export interface AlContextBody {
  readonly context: string;
  readonly tokens_used: number;
  readonly symbols_included: readonly string[];
  readonly library_docs_included?: readonly string[];
  readonly suggestions?: readonly string[];
}

/** Aleutian `SymbolInfo` (API response symbol shape). */
export interface AlSymbolInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly file_path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly signature?: string;
  readonly doc_comment?: string;
  readonly package?: string;
  readonly exported?: boolean;
}

/** `GET /v1/trace/symbol/:id` body. */
export interface AlSymbolBody {
  readonly symbol: AlSymbolInfo | null;
}

/** One `GET /v1/trace/references` entry. */
export interface AlReferenceInfo {
  readonly file_path: string;
  readonly line: number;
  readonly column?: number;
}

/** `GET /v1/trace/references` body. */
export interface AlReferencesBody {
  readonly symbol: string;
  readonly references: readonly AlReferenceInfo[];
}

/** The standard Aleutian error body: `{ error, code, details? }`. */
export interface AlErrorBody {
  readonly error?: string;
  readonly code?: string;
  readonly details?: string;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Normalizes discovered Aleutian state into the shared capability set. Reachable+ready grants
 * symbol/graph/context/status; a healthy Weaviate additionally grants semantic search. `mcp`
 * transport (which cannot be HTTP-discovered) advertises the known static graph tool set. This is
 * the ONE place Aleutian's breadth is projected onto Belay's normalized capabilities (M5).
 */
export function normalizeCapabilities(input: {
  readonly transport: "http" | "mcp";
  readonly reachable: boolean;
  readonly ready: boolean;
  readonly weaviateOk: boolean;
  readonly tools: readonly string[];
}): {
  readonly readiness: SourceRecallReadiness;
  readonly capabilities: readonly SourceRecallCapability[];
} {
  if (input.transport === "mcp") {
    // trace-mcp exposes the graph tools but no HTTP discovery; advertise the known static set.
    return {
      readiness: "ready",
      capabilities: ["symbol_search", "call_graph", "status"],
    };
  }
  if (!input.reachable) {
    return { readiness: "unreachable", capabilities: [] };
  }
  if (!input.ready) {
    return { readiness: "unready", capabilities: ["status"] };
  }
  // `/context` is a core Trace endpoint (present whenever the server is ready), so context assembly
  // is granted alongside the graph tools; the semantic axis is what a down Weaviate removes.
  const capabilities: SourceRecallCapability[] = [
    "symbol_search",
    "call_graph",
    "context_assembly",
    "status",
  ];
  if (input.weaviateOk) {
    capabilities.push("semantic_index");
  }
  return { readiness: "ready", capabilities };
}

/**
 * Normalizes one Aleutian `SymbolInfo` into a {@link SourceRecallResultItem} with a file/line
 * citation. The docComment/signature become the bounded snippet (capped by `maxSnippet`); the raw
 * signature/package/kind ride in `meta` for detail views. `rank` seeds a descending pseudo-score so
 * the caller can order symbols returned in context order.
 */
export function symbolToResultItem(
  providerId: string,
  symbol: AlSymbolInfo,
  rank: number,
  total: number,
  maxSnippet: number,
  matchReason = "aleutian:context",
): { readonly item: SourceRecallResultItem; readonly truncated: boolean } {
  const signature = str(symbol.signature);
  const doc = str(symbol.doc_comment);
  const raw = [signature, doc].filter(Boolean).join("\n") || str(symbol.name);
  const truncated = raw.length > maxSnippet;
  const snippet = truncated ? `${raw.slice(0, maxSnippet)}…` : raw;
  const pkg = str(symbol.package);
  return {
    truncated,
    item: {
      providerId,
      filePath: str(symbol.file_path),
      startLine: num(symbol.start_line),
      endLine: num(symbol.end_line),
      symbolName: str(symbol.name),
      symbolType: str(symbol.kind, "symbol"),
      snippet,
      // A descending rank in [0,1]: context order is the relevance signal Trace gives us.
      score: total > 0 ? Math.max(0, 1 - rank / total) : 0,
      matchReason,
      searchQuality: "graph",
      repoName: null,
      meta: {
        ...(signature ? { signature } : {}),
        ...(pkg ? { package: pkg } : {}),
        exported: symbol.exported === true,
      },
    },
  };
}

/** Normalizes one reference (file/line/column) into a citation-only result item (no snippet body). */
export function referenceToResultItem(
  providerId: string,
  symbolName: string,
  ref: AlReferenceInfo,
  rank: number,
  total: number,
): SourceRecallResultItem {
  return {
    providerId,
    filePath: str(ref.file_path),
    startLine: num(ref.line),
    endLine: num(ref.line),
    symbolName,
    symbolType: "reference",
    snippet: "",
    score: total > 0 ? Math.max(0, 1 - rank / total) : 0,
    matchReason: "aleutian:reference",
    searchQuality: "graph",
    repoName: null,
    ...(typeof ref.column === "number" ? { meta: { column: ref.column } } : {}),
  };
}

/** True when the parsed body is an Aleutian error envelope (`{ error, code }`). */
export function isErrorBody(body: unknown): body is AlErrorBody {
  return (
    typeof body === "object" &&
    body !== null &&
    (typeof (body as AlErrorBody).error === "string" ||
      typeof (body as AlErrorBody).code === "string")
  );
}
