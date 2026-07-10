# Vendored assistant-ui components

These are Trevor-**owned copies** of assistant-ui components. Trevor does not run the
assistant-ui runtime - the durable session log + host turn loop + transcript projection
are the source of truth (58.6 D-002).

Before bumping `@assistant-ui/react` / `@assistant-ui/react-markdown` or re-vendoring a
component here, read the governance policy: **CONTEXT.md → "assistant-ui dependency
governance"**. It carries the exact version pins, the live-coupling ledger, the render
smoke tests that must stay green across a bump, and the drift check
(`pnpm --filter @trevor/web check:assistant-ui-drift`).

The packages are pinned to **exact** versions on purpose - never widen a pin back to a caret.
