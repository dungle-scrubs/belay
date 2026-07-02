// The LSP fixture-workspace surface, re-exported for the e2e workspace via the
// `@trevor/agent-host/testing/lsp-fixtures` export (the mcp-fixtures precedent, plan 24 M9).
// Strictly side-effect-free (node builtins only), so cross-service e2e can import it STATICALLY
// and lay the workspace on disk BEFORE TREVOR_WORKSPACE binds and any host module loads.
export {
  createEvalWorkspace,
  type EvalWorkspaceOptions,
  installEvalServer,
} from "../lsp/eval-workspace";
