/**
 * The host's ONE secret-minimal child-environment policy (D-004): a long-lived protocol child
 * (an MCP stdio server, a language server) inherits ONLY these host env vars - never provider
 * keys, TREVOR_* state, or anything else in the host's environment. Extracted from
 * mcp/stdio-transport + lsp/client because a security allowlist duplicated per spawner is a
 * policy waiting to drift; both spawners now share this single definition.
 *
 * Responsible for: the minimal child env allowlist and the filter that applies it.
 * Not for: spawning (the transports/clients own their children) or per-server explicit env
 * semantics (callers pass those through `extra`).
 */

/** The ONLY host env vars a protocol child inherits (plus any caller-explicit extras). */
export const MINIMAL_CHILD_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"] as const;

/** The secret-minimal child environment: allowlisted host vars, then explicit extras on top. */
export function minimalChildEnv(
  hostEnv: NodeJS.ProcessEnv,
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of MINIMAL_CHILD_ENV_ALLOWLIST) {
    const value = hostEnv[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }

  return { ...env, ...extra };
}
