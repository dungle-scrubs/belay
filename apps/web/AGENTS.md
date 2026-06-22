# apps/web - Agent Instructions

`apps/web` is the Trevor V2 browser frontend: React 19 + Vite + Effect, a
Richter WebSocket participant. These instructions govern how hooks are written
here.

## Use ahooks proactively and generously

[ahooks](https://ahooks.js.org/) is the default for hook-shaped logic in this
app. Reach for it not only before writing a custom hook, but in place of raw
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
4. **When it fights Effect or React.** Keep the Effect island (Schema decode, WS
   client) and React boundaries clean; do not wrap Effect-owned lifecycle in an
   ahooks hook just to use one.

### Scope of refactors

Apply ahooks to new code by default, and swap out raw-hook usages you are
already touching. Do not open large standalone refactor diffs across untouched
files unless asked.

## TanStack for data, tables, and forms

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

