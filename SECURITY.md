# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability.

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/dungle-scrubs/belay/security/advisories/new).
This creates a draft advisory visible only to the maintainers.

Include what you have: the affected component, what an attacker can do, and the
steps or proof-of-concept needed to reproduce it. A short report you can write
today is more useful than a thorough one you never send.

You can expect an acknowledgement within a week. If a report is confirmed, the
fix and the advisory are published together.

## Supported versions

Belay is pre-1.0 and under active development. Only the latest release on `main`
receives security fixes.

## Known limitations - read before reporting

Belay is currently a **trusted local developer tool**. It is not hardened
against a hostile browser, a malicious extension, a malicious local webpage, or
another user on a shared machine.

[`SECURITY_RISKS.md`](./SECURITY_RISKS.md) enumerates the weaknesses that are
already known and accepted under that assumption - unauthenticated local
services, permissive CORS, a forgeable client-supplied `producerId`, and a
shell lane guarded by a deny-list rather than a sandbox. These are tracked, not
secrets, and a report restating one of them tells us nothing new. What is
valuable is a concrete escalation beyond the trusted-local threat model, or a
weakness that document does not already cover.

## Scope

Belay runs AI agents against a local workspace with real filesystem, shell, and
network reach. An agent executing a tool the operator approved is the product
working as designed, not a vulnerability.

Findings that are in scope include:

- Sandbox escapes: a tool script reaching outside its declared read and write
  roots.
- Approval bypasses: an action taking effect without the operator confirmation
  it requires.
- Confused-deputy issues: untrusted content in a transcript, tool result, or
  MCP response steering the agent into privileged actions on its own.
- Secret disclosure: credentials leaking into logs, telemetry, blobs, or the
  session transcript.
- Authentication or isolation flaws in the session store, blob store, or the
  Tether transport between participants.
