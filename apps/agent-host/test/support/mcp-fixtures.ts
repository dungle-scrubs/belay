// The MCP fixture surface, re-exported for the e2e workspace via the
// `@belay/agent-host/testing/mcp-fixtures` export (plan 23 M9). A SEPARATE entry from
// ./index.ts on purpose: these modules touch only node builtins (plus type-only host imports),
// so e2e can start fixture servers and learn their ephemeral endpoints BEFORE importing the
// heavy testing surface - whose host singletons read `<BELAY_HOME>/mcp-servers.json` at
// import time and therefore need the config file already on disk.

export * from "../mcp/fixture-catalog";
export * from "../mcp/fixture-config";
export * from "../mcp/fixture-http-server";
