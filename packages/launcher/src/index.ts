/**
 * `@trevor/launcher` - the pure launch-orchestration core extracted from `apps/trevor-cli` (plan 44.1),
 * callable by BOTH the `trevor` CLI and the supervisor daemon (and, later, a desktop core) over an
 * injected platform.
 *
 * It OWNS:
 *  - project + session identity: `resolveProjectRoot`, `resolveSession`, `projectSessionId`, the
 *    persisted root->session map (`projects.json`);
 *  - host lifecycle bookkeeping: the reuse/spawn/replace-stale decision (`decideHostAction`), the
 *    ownership records (`hosts.json`), and the per-session launch lock;
 *  - shared-service classification (`classifyService`) and the reserved-port set the launcher ensures;
 *  - the `launch(platform, options)` orchestrator that ties them together over an injected
 *    `LaunchPlatform`, plus the real node-backed `nodePlatform`.
 *
 * It is NOT:
 *  - CLI arg parsing / usage / subcommand dispatch (that stays in `apps/trevor-cli`);
 *  - an `@trevor/sdk` client, headless verbs, or terminal rendering;
 *  - a session-log participant - the launcher never subscribes to a session (the supervisor does).
 * All machine-local state stays under `TREVOR_STATE_HOME` via `@trevor/session/node-paths`; this
 * package adds no new storage roots.
 */
export * from "./fs";
export * from "./host-registry";
export * from "./launch";
export * from "./platform";
export * from "./project";
export * from "./project-registry";
export * from "./services";
