/**
 * Context source identity for the context subsystem. `ContextSource`/`ContextSourceDiagnostic` are
 * the shared shape; the kind map enumerates the source kinds actually produced. Today only Trevor
 * rules flow through this shape (AGENTS.md ingestion keeps its own `ContextScope`); add a kind here
 * when a second producer (e.g. CLAUDE.md migration diagnostics) is wired into prompt output, rather
 * than advertising kinds nothing emits.
 *
 * Responsible for: the shared ContextSource/ContextSourceDiagnostic shapes + the kind enumeration.
 */

export const CONTEXT_SOURCE_KINDS = {
  trevorRule: "trevor-rule",
} as const;

export type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[keyof typeof CONTEXT_SOURCE_KINDS];

export interface ContextSourceDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly severity: "info" | "warn" | "error";
}

export interface ContextSource<TMetadata extends object = Readonly<Record<string, unknown>>> {
  readonly bytes: number;
  readonly content: string;
  readonly diagnostics: readonly ContextSourceDiagnostic[];
  readonly kind: ContextSourceKind;
  readonly metadata: TMetadata;
  readonly path: string;
  readonly provenance: string;
}
