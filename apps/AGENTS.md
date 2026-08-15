# apps - Agent Instructions

`apps/` holds every Belay application, and these rules cover all of them:

- **`apps/web`** - the browser frontend: React 19 + Vite, a Tether
  WebSocket participant.
- **`apps/agent-host`** - the host: Node + Effect, also a Tether participant,
  running the agent loop (model <-> tools) for each turn.

These layer on the project-wide rules in the repo-root
[`AGENTS.md`](../AGENTS.md). Each section below states its **scope**: the
Effect adoption policy governs every app here; ahooks and TanStack are
React-only and apply to the frontend (`apps/web`), never to the Node host.

## Effect - adoption policy for all apps

Scope: every app under `apps/`. Today only `apps/agent-host` has adopted
Effect (the stable v3 `effect` core). `apps/web` does not depend on Effect:
its wire decoding rides the Schema codecs owned by `@belay/session`, which
collapse to plain types, callbacks, and Promises at the package edge.

Follow the house policy in the `effect-standards` skill: **adopt Effect only
where it buys a measurable benefit over plain TypeScript** - typed error
propagation across many call sites, structured concurrency (racing, bounded
parallelism, cancellation, retry with backoff), resource safety (`Scope` /
`acquireRelease`), dependency injection via `Layer` / `Context.Tag`, or
`Schema`-driven validation at a trust boundary. Effect is **not** the default
style for every file. A leaf utility, a thin adapter, or a lone `tryCatch` /
single `Promise.all` stays plain TypeScript per `typescript-standards` (Result
types, discriminated unions, typed error classes) - do not pull in Effect just
to get those.

This policy governs the *decision* to adopt. The host (`apps/agent-host`) has crossed
that threshold: its turn pipeline and control plane are an Effect program (typed
`Data.TaggedError` channel, `Stream`, fiber-interrupt cancellation, `Context.Tag` +
`Layer` DI), so new code there stays inside it rather than re-deciding per file. See
[`apps/agent-host/AGENTS.md`](./agent-host/AGENTS.md) for the host's stay-in-Effect stance
and the boundaries it deliberately keeps imperative.

- **Stable core only.** Target the semver-stable v3 `effect` core - no
  `alpha` / `beta` / `rc` / `next` dist-tags, the same discipline as TanStack
  below. Ecosystem packages (`@effect/platform` and other not-yet-stable
  modules) are less settled; prefer the stable core, and where a needed piece
  exists only pre-stable, surface that gap rather than silently depending on a
  pre-release.
- **Keep islands clean to their boundary.** Where a call graph is Effect, keep
  it Effect to its edge, then convert to a plain Promise / Result there
  (`Effect.runPromise` / `Effect.runPromiseExit`). Do not half-adopt inside one
  module, and do not let an isolated Effect island fight a surrounding sea of
  plain Promises.
- **Schema / decode at trust boundaries.** Decoding wire data (e.g. Tether
  envelopes via `@belay/tether`) returns an `Either`; branch on it explicitly
  (`Either.isLeft`, as in `apps/agent-host/src/main.ts`) rather than trusting
  the shape. One schema is the source of truth for parse, decode, and typed
  error.

## ahooks - React apps only

Scope: React frontend apps (currently `apps/web`). Does **not** apply to the
Node host - ahooks is a React hook library with no place in `apps/agent-host`.

[ahooks](https://ahooks.js.org/) is the default for hook-shaped logic in React
code. Reach for it not only before writing a custom hook, but in place of raw
`useState` / `useEffect` / `useRef` whenever an ahooks hook covers the case.
Treat a raw hook that maps cleanly onto an ahooks hook as a smell to replace,
not merely tolerate - including when you are already editing nearby lines.

The default is flipped: ahooks is what you pick, and a raw hook is what you
justify.

### Reach for an ahooks hook when

**State shape maps to a hook:**
- `useState(false)` for a flag -> `useBoolean` (gives `toggle`/`setTrue`/`setFalse`)
- toggling between two values -> `useToggle`
- a numeric counter with inc/dec -> `useCounter`
- object state you spread-merge -> `useSetState`
- `Map` / `Set` state -> `useMap` / `useSet`

**Effect patterns:**
- mount-only `useEffect(() => {}, [])` -> `useMount`
- cleanup-only effect -> `useUnmount`
- any `setInterval` / `setTimeout` + cleanup -> `useInterval` / `useTimeout`
- manual event-listener add/remove -> `useEventListener`, `useClickAway`,
  `useKeyPress`, `useHover`, `useScroll`

**Browser APIs (never hand-roll these):**
- localStorage / sessionStorage sync -> `useLocalStorageState` / `useSessionStorageState`
- `ResizeObserver` -> `useSize`; `IntersectionObserver` -> `useInViewport`
- `navigator.onLine` -> `useNetwork`; `document.title` -> `useTitle`

**Timing / perf:** debounce or throttle a value or function ->
`useDebounce` / `useDebounceFn` / `useThrottle` / `useThrottleFn`, not a lodash
wrapper or hand-written timer.

**Previous value:** `usePrevious` instead of the `useRef` "track last value"
dance.

### Do not use ahooks when

1. **Data fetching - the hard exception.** Never ahooks `useRequest`. Server
   state and async data go through TanStack Query (see "TanStack" below), not
   ahooks.
2. **Genuinely trivial inline state** - a single `useState` with a plain setter
   that is not a boolean/counter/object pattern. Wrapping it adds indirection
   for no gain.
3. **One-shot mount effect with no cleanup and no semantics** - `useMount` is
   fine but not forced for a true one-liner.
4. **When it fights the session transport or React.** Keep the
   `@belay/session` boundary (Schema decode, WS client) and React boundaries
   clean; do not wrap transport-owned lifecycle in an ahooks hook just to use
   one.

### Scope of refactors

Apply ahooks to new code by default, and swap out raw-hook usages you are
already touching. Do not open large standalone refactor diffs across untouched
files unless asked.

## TanStack for data, tables, and forms - React apps only

Scope: React frontend apps (currently `apps/web`). Does **not** apply to the
Node host.

Use the TanStack family (stable releases only) for these three concerns. They
are the default; reach for them rather than hand-rolling fetch/cache, table, or
form state.

### Data fetching - TanStack Query

All server state and async data goes through `@tanstack/react-query`, never
ahooks `useRequest` or a raw `useEffect` + `useState` fetch.

- `useQuery` for reads; gate dependent queries with `enabled`.
- `useMutation` for writes; invalidate or update the cache in `onSuccess` /
  `onSettled` (optimistic updates via `onMutate` + rollback in `onError`).
- Query keys are arrays, most-specific-last:
  `['sessions']`, `['sessions', sessionId]`, `['sessions', { status }]`.
- Do not store fetched server data in component state or a global store; let the
  query cache own it.

### Tables - TanStack Table

Use `@tanstack/react-table` for any data grid: sorting, filtering, pagination,
column visibility, row selection. It is headless - render with the app's table
primitives, keep column defs (`columnHelper`) in one place per table, and feed
it data from a TanStack Query result rather than ad hoc state.

### Forms - TanStack Form

Use `@tanstack/react-form` for forms with validation, field-level state, or
submit handling. Drive submission through a `useMutation` rather than a manual
async handler. A single uncontrolled input with no validation does not need it.

## UI styling - React apps only

Scope: React frontend apps (currently `apps/web`). Does **not** apply to the
Node host.

**Every interactive element shows a pointer cursor - enforced globally, not per
component.** A base-layer rule in [`apps/web/src/index.css`](./web/src/index.css)
gives `cursor: pointer` to every `<button>`, `[role="button"]`, tab, menu item,
option, `<a href>`, `<summary>`, and `label[for]`, and `cursor: not-allowed` to
anything `:disabled` or `[aria-disabled="true"]`. This exists because the browser
default for `<button>` is `cursor: default` and shadcn buttons don't fix it, which
left clickable controls feeling inert.

Because the base rule covers it, **do not sprinkle `cursor-pointer` on individual
components** - a standard `<button>` / `role="button"` is already correct. Only
reach for an explicit Tailwind `cursor-*` when a control is NOT one of the matched
selectors (e.g. a clickable plain `<div>` with no role - which you should usually
give a proper role/button instead) or to deliberately override the base. If you
ever find yourself adding `cursor-pointer` to a real button, the base rule is the
bug to fix, not the component.
