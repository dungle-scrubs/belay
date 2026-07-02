# Agent Host Architecture Map

The by-domain map of `apps/agent-host/src` (plan 22.1): what each subsystem owns and where a
reader should look first. Every module carries a `Responsible for:` header in its first block
comment (see [AGENTS.md](./AGENTS.md) "Structure and naming"); this file is the directory-level
view, kept honest by `test/architecture-map.test.ts`.

The host is a Node + Effect Richter participant: it joins a session's durable event stream,
elects a leader through the session lease, and runs the agent loop (model <-> tools) for each
turn. `main.ts` is the only file at `src/` root - the composition root that wires the transport
edge, replay dispatch, the command lane, and turn dispatch together.

## Subsystems

### Startup and configuration

- `boot/` - process startup: CLI args, env overrides, the host config file, tolerant numeric
  coercions, storage-root paths, session ensure-with-retry, and skill/command manifest
  frontmatter parsing.
- `connectivity/` - internet reachability probing surfaced to the web client.
- `telemetry/` - Sentry wiring and span helpers over `@trevor/session/telemetry`.

### Session control plane

- `session/` - one session's ownership and lifecycle: the time-injected leader lease, the cwd
  advisory lock, session-lifecycle state, the fork operation, workspace switching, and the
  control-model preference.
- `admission/` - capacity-gated admission of hosts to shared resources (config, contract,
  store).
- `residency/` - model residency: claims, controller, and eviction ordering for local models.
- `processes/` - background process registry, output rings, and pid-liveness checks shared by
  the file-based locks.

### The turn pipeline

- `agent/` - the agent loop and turn machinery: composing provider streams with tool execution,
  turn publication (`turn.ts`), preflight context checks, history compaction and recall
  (`recall/`), and turn-time image resolution for vision models.
- `providers/` - model providers and their shared contracts: the pi-ai adapters, LM Studio
  client/native adapters, auth, model metadata, capabilities, and the system prompt.
- `project-context/` - project instruction discovery: AGENTS.md/CLAUDE.md registry, scoping,
  and migration (renamed from the old `context` dir, D-006).
- `manifest/` - the capabilities manifest the host announces: build, sections, and the expert
  keyword routing.

### Tools and commands

- `tools/` - the model-facing tool set and executor: fs read/write/edit, glob/grep/ast-grep,
  bash + safety, archive, docs, web-fetch, clipboard + `/clip`, promote, ask-user, open-editor,
  and the working checklist (`tasks/`).
- `tool-script/` - the tool-scripting bridge: hashing, sandboxing, and execution of script
  tools.
- `commands/` - the slash-command registry, debug commands, and the `!command` general
  interpolation trust gate.
- `mcp/` - the host-owned MCP client runtime (plan 23): the named-server config + registry
  (tool-proxy is one ordinary named server), the shared transport contract, Content-Length
  framing, the stdio transport with its secret-minimal child environment, the Streamable
  HTTP/SSE transport with session identity and redacted bearer auth, capability discovery +
  the per-server cache with qualified identity and capped search, and the host-lifetime
  runtime seam (`runtime.ts`): lazy per-server connections, qualified tool calls through the
  host tool contract, resources as bounded provenance-carrying context records, prompts as
  imported artifacts (never slash commands), host-owned mediation of server-originated
  elicitation and budget-gated off-by-default sampling (`mediation.ts`), and the redacted
  per-server status snapshot.
- `lsp/` - the host-owned LSP integration (plan 24): the stable read-only result contract with
  typed degraded outcomes (unavailable/unsupported/timeout/stale/server_error - degradation is
  data, never a thrown turn failure), result-size caps, the generic language-server adapter
  boundary with the TS/JS adapter first, the JSON-RPC client over stdio (reusing `mcp/`'s
  Content-Length framing), and the per-workspace-root runtime manager with lazy spawn, bounded
  restart-on-crash, and status snapshots.
- `skills/` - skill discovery and progressive disclosure behind the skills tools.
- `subagents/` - subagent discovery (`discovery.ts`) for delegated agents.
- `serial-run/` - the serialized multi-plan run lane.
- `loop/` - the `/loop` recurring-prompt domain and command.

### Transport and observability edges

- `transport/` - the emit/IPC edge helpers: the `Emit` service publishing session events, the
  streamed-text delta buffer, error->message normalization, and the structured boundary logger.
- `doctor/` - the `/doctor` health snapshot of workspace, providers, and tools.
- `metrics/` - usage breakdown reporting.

### User preferences and flows

- `prefs/` - host-persisted user preferences: Vim prompt motions and response style.
- `handoff/` - the session handoff flow and handoff-prompt generation.
- `worktrees/` - managed git worktrees and git status reads.

## Conventions

- Plural dir = a collection of peers; singular dir = one cohesive subsystem.
- No catch-all dirs; a leaf helper joins the subsystem that owns its concept.
- Cross-subsystem imports in new/moved code use `@host/*`; same-dir imports stay relative; no
  new `index.ts` barrels.
- Enforced by `test/structure.test.ts` (root flatness), `test/header-check.test.ts` (module
  headers), and `test/architecture-map.test.ts` (this map).
