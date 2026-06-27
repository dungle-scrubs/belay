/**
 * Context source identity shared by AGENTS.md ingestion, Trevor rules, and
 * instruction-file migration diagnostics. Rendering remains owned by the
 * existing D-080 context registry; these types make new sources explicit before
 * they are wired into prompt output.
 */

export const CONTEXT_SOURCE_KINDS = {
  agentsMd: "agents-md",
  claudeMigration: "claude-migration",
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
