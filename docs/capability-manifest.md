# Capability Manifest, `trevor-export`, and `trevor-expert`

Trevor generates a **capability manifest** - a structured, versioned answer to "what can this host do?" -
from its **live registries** (tools, commands, command families, output styles, skills, agents, MCP/LSP/
hooks/docs runtimes, Doctor areas, the model provider/catalog, runtime, protocol, and workspace). It is
**derived, never handwritten**: changing a registry changes the manifest. The manifest **describes**
capabilities; it never **grants** them - it is not a permission system.

- **`/trevor-export`** is the host-owned export command/API for humans, clients, and subagents.
- **`trevor_expert`** is a built-in, read-only tool that answers questions about Trevor from the manifest.

## Scopes

One schema serves every reader; the **scope** controls density and visibility. `full` vs `compact` are the
same shape at different scopes, so the prompt view can never drift from the human view.

| Scope | For | Shows |
|---|---|---|
| `human` | the terminal / a person | everything, incl. debug + non-available capabilities, tagged |
| `client` | a UI / API client | same as human |
| `compact` | a token-budgeted prompt block | usable capabilities only, capped, with discovery pointers |
| `subagent` | a spawned agent's context | scoped compact slice |
| `expert` | the built-in `trevor_expert` | scoped slice loaded on demand |

The full (`human`/`client`) manifest is **export-only** and is never injected into a turn.

## `/trevor-export`

```
/trevor-export [--json] [--compact | --expert] [--section <id>] [--scope <scope>]
```

| Flag | Effect |
|---|---|
| _(none)_ | full human-readable text |
| `--json` | stable, decodable JSON (for clients - parse it, don't scrape prompt text) |
| `--compact` | budgeted prompt block at the `compact` scope |
| `--expert` | budgeted prompt block at the `expert` scope |
| `--section <id>` | restrict to one section (see ids below) |
| `--scope <scope>` | explicit scope override (`human`/`client`/`compact`/`subagent`/`expert`) |

**Section ids** (canonical order): `tools`, `commands`, `commandFamilies`, `styles`, `skills`, `agents`,
`mcp`, `lsp`, `hooks`, `docs`, `doctor`, `catalog`, `runtime`, `protocol`, `workspace`.

Every variant is **bounded** (per-scope item caps; a truncated section carries `total` + a `detail`
pointer to fetch the rest) and **redacted** (secrets, auth headers, and absolute home paths are stripped
before anything leaves the host). Sections are emitted in canonical order, so output is **deterministic**.
A subsystem with no live backend (MCP/LSP/hooks/docs until their runtimes land) is an explicit
`unavailable` section, never a silently missing one.

### JSON shape (for clients)

```jsonc
{
  "version": 1,
  "scope": "human",
  "generatedAt": "2026-07-01T00:00:00.000Z",
  "host": { "version": "2.0.0" },
  "workspace": { "root": "trevorV2" },      // collapsed label, never an absolute path
  "truncated": false,
  "sections": [
    {
      "id": "tools",
      "title": "Tools",
      "status": "ok",                        // ok | empty | unavailable | truncated | error
      "items": [
        { "id": "read", "label": "read", "summary": "Read a file", "meta": { "readOnly": true } }
      ],
      "provenance": { "source": "tool-registry", "fresh": true }
    }
  ]
}
```

Decode it defensively with `decodeCapabilityManifest` from `@trevor/session` - it drops unknown-id
sections and scrubs items to descriptive-only (no field carries executable authority).

## `trevor_expert`

A built-in, **read-only** model-facing tool. Its tool definition is the discovery metadata (the model
sees it exists and when to use it); the manifest is loaded **only when it is called**, never dumped into
every prompt. Given a question it routes to the **few relevant sections** (never the whole manifest),
loads those export slices via a **direct host export path**, and answers with **provenance** and explicit
**unknown/unavailable** states. It never mutates state, grants a permission, starts work, or bypasses
tool/command authority.

## Interpolation boundary

General `!command` interpolation inside skill/command files is a **separate feature, disabled by default**.
It is enabled only by an explicit opt-in (`TREVOR_ENABLE_INTERPOLATION=1`); even then the only sanctioned
interpolation target is the read-only `/trevor-export`, and interpolated output is allow-listed, capped,
timed out, run at the workspace root, and redacted. The built-in `trevor_expert` reads the manifest through
its own direct path and works **regardless** of this gate.
