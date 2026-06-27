# Trevor V2 Security Risks

Trevor V2 is currently best treated as a trusted local developer tool with a
browser UI. It is not secure against a hostile browser, malicious extension,
malicious local webpage, or shared-machine attacker.

## Core Risk

The main risk is the local service boundary. The browser can publish events to
local services, and the host treats those events as user intent. Some of those
intents can trigger privileged local actions such as shell commands, editor
opens, worktree changes, host restart, and model/tool execution.

This means Trevor is safe only under a trusted-local-browser assumption unless
the local HTTP/WebSocket services add authentication and origin enforcement.

## Findings

- `apps/session-store/src/server.ts` uses permissive CORS and has no
  authentication.
- `POST /sessions/<id>/events` accepts events from anyone who can reach the
  session-store.
- The session WebSocket stream does not validate the `Origin` header.
- `producerId` is client-supplied and forgeable, so it should not be treated as
  authority.
- The host runs commands/actions for any non-host event once it decodes as a
  supported Trevor event.
- The prompt shell lane can execute shell commands through the host. Its safety
  layer is a deny-list, not a sandbox.
- `apps/blob-store/src/main.ts` logs a loopback URL but calls `listen(PORT)`
  without explicitly binding `127.0.0.1`, so the actual bind behavior should be
  tightened.
- The main markdown renderer sanitizes model-authored HTML with DOMPurify, which
  is good, but the web app does not currently show an explicit CSP in
  `apps/web/index.html`.
- Browser extensions with broad permissions remain outside the app's control and
  should be treated as equivalent to a compromised browser session.

## Priority Fixes

1. Add a per-launch unguessable capability token required by the session-store,
   blob-store, web client, and host.
2. Reject HTTP and WebSocket requests unless `Origin` is exactly Trevor's local
   UI origin. Treat missing or unexpected origins conservatively.
3. Bind every local service explicitly to `127.0.0.1`, including blob-store.
4. Stop using `producerId` as an authority signal. Authenticate the publisher at
   the transport boundary instead.
5. Add host-side policy gates for privileged actions such as `user.shell`,
   `editor.open`, worktree mutation, `/restart`, and model/tool execution.
6. Add CSP and, where practical, Trusted Types for the web UI.
7. Keep durable secrets out of browser storage and rendered DOM. Store authority
   in the host, not the frontend.
8. For stronger operational isolation, run Trevor in a dedicated browser profile
   or browser instance with extensions disabled.

## Security Model

Until these fixes exist, Trevor's practical security model is:

- Trusted local user.
- Trusted browser profile.
- Trusted browser extensions.
- Trusted local web origins, or at least no malicious website attempting
  localhost access.
- Local services reachable only from the same machine.

That model is acceptable for some personal development workflows, but it should
not be presented as a hardened local control plane.
