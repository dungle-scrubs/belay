import { createHooksRuntime, type HooksRuntime } from "./runtime";

/**
 * The host-wide hooks runtime singleton (plan 25 M5), in the mcp/lsp host-runtime tradition: one
 * lazy runtime over the default roots (`<workspace>/.trevor/hooks.json` + `<TREVOR_HOME>/hooks.json`),
 * shared by every turn's tool boundary (main, subagent, and clip turns - main.ts and
 * agent/delegate.ts bind it) and, from M9, by /doctor. Construction reads and spawns NOTHING:
 * discovery happens on the first dispatch and is cached for the host's lifetime, while approvals
 * are re-read per dispatch so a fresh grant needs no restart. A host with no hooks configured
 * pays one cached empty discovery and nothing else.
 *
 * Responsible for: constructing and exporting the one host hooks runtime.
 * Not for: dispatch semantics (./runtime) or loop-side enforcement (@host/agent/loop).
 */

/** The one host hooks runtime; lazy, so importing this reads nothing. */
export const hooksRuntime: HooksRuntime = createHooksRuntime();
