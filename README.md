# Belay

A browser UI and an agent host that communicate only through a durable session log.

Belay runs AI coding agents. The browser and the host never address each other
directly - both read from and append to an append-only event log held by a
session store, and all UI state is projected from that log. Because nothing in
the system holds a direct connection to anything else, a session survives the
browser tab closing, the host restarting, or the UI running on a different
machine from the work.

It exists as a step toward [Tether](https://github.com/dungle-scrubs/tether), a
separate durable-sessions project where that log lives in the cloud and the
coordinator - human or agent - speaks to the session rather than to the agent.
Tether itself is out of scope here. Belay is where the local half was built, and
the browser UI came from wanting finer control over the session than a terminal
gives.

This is a personal experiment, shared as-is. It is not a tool seeking adoption,
and remote agent driving is common now in tools that did not exist when this
started.

## How it fits together

Four processes, each a participant on the same session log:

| Process | Role | Port |
|---------|------|------|
| `apps/session-store` | SQLite event log, WebSocket fan-out | 17424 |
| `apps/blob-store` | Content-addressed artifact storage (sha256, immutable) | 17423 |
| `apps/agent-host` | Runs the model ↔ tools loop for each turn | - |
| `apps/web` | React 19 browser UI | 17420 |

The host holds a lease, so exactly one host answers prompts for a session even if
several are running. Everything else - transcript, tool calls, streaming deltas,
questions the agent asks back - is an event on the log that any participant can
replay from the beginning or subscribe to live.

## Requirements

- **Node.js 22 or newer.** CI runs Node 24, where `node:sqlite` is stable.
- **pnpm 11.5.2**, pinned via `packageManager`. Run `corepack enable` and the
  right version is selected automatically.

## Install

```bash
git clone git@github.com:dungle-scrubs/belay.git
cd belay
pnpm install
```

## Use it

Start all four processes together:

```bash
pnpm dev
```

Then open <http://127.0.0.1:17420>.

To run the web UI alone against stores that are already up:

```bash
pnpm dev:web
```

## The CLI

The same session log is driveable from a terminal. `pnpm belay` runs the CLI in
this repo.

```
belay list [--archived]              List this project's sessions
belay prompt <session> <text>        Submit a prompt and stream the turn
belay transcript <session>           Print the session transcript
belay cancel <session> <runId>       Cancel the active run
belay stop <session>                 Gracefully shut down the session's host
belay kill <session>                 Force-terminate a wedged host
belay models                         List model ids and reasoning levels
belay capabilities <session>         Print the host capability manifest
belay doctor <session>               Print the host /doctor snapshot
belay artifact put <file>            Upload a content-addressed artifact
belay artifact get <hash> [outfile]  Download one
belay archive <session>              Archive a session
belay unarchive <session>            Restore an archived one
```

`prompt`, `transcript`, `models`, and `capabilities` accept `--json` for machine
output. `prompt` also takes `--model`, `--reasoning`, and `--timeout`.

## Concepts

**Everything is an event.** `user.*`, `assistant.*`, `tool.*`,
`provider.question.*`, `handoff.*`, `context.*`, `session.*`, `host.*`. The
protocol lives in `packages/session/src/protocol.ts`. State is never stored
anywhere but the log; the UI and the host each project their own view of it.

**One leader per session.** Hosts take a lease before answering. A second host
attached to the same session stays quiet until the lease frees up, which is what
makes restarting a host mid-session safe.

**Turns end for a reason.** A turn does not stop at a fixed step count. The
adaptive budget treats the backstop as a checkpoint: a turn with context headroom
and demonstrable progress auto-continues, and terminates on the step axis only at
a hard ceiling of 256 or when context stops advancing. Context pressure and loop
stalls remain authoritative stops.

## Contributing

```bash
pnpm lint            # Biome, plus the repo filename and residual-name policies
pnpm -r typecheck    # TypeScript across every workspace package
pnpm test            # the full Vitest suite
```

Test lanes run individually: `test:unit`, `test:integration`, `test:web`,
`test:e2e`, `test:e2e:browser`, and `test-storybook`. The browser lanes are
local-only and need Docker; they run in a pinned Playwright container, and their
screenshot baselines are architecture-specific, so they never run in CI.

[CONTRIBUTING.md](./CONTRIBUTING.md) has the full workflow and commit
conventions if you are working in a fork.

## Status

Pre-1.0 and under active development. The feature ledger in
[FEATURES.md](./FEATURES.md) records what actually exists in the code, with an
implementation anchor and a test reference for every entry.

Belay assumes a trusted local machine. The local services have no
authentication, CORS is permissive, and the shell lane is guarded by a deny-list
rather than a sandbox. [SECURITY_RISKS.md](./SECURITY_RISKS.md) enumerates the
known weaknesses; read it before pointing Belay at anything you care about.

## License

[MIT](./LICENSE)
