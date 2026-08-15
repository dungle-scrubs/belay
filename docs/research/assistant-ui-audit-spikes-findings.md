# Progress Report - Assistant-UI Audit Research Spikes

**Plan:** `58.6.3-audit-research-spikes`
**Stage:** research complete (measurements + go/no-go recorded); M1 absolute perf numbers need a real
dev-machine browser run (flagged below).
**Current focus:** done - all three milestones' decisions recorded.

Research-only (58.6 D-002): nothing adopts assistant-ui, changes a wire contract, or touches the durable
log. Scaffolds live in `artifacts/` and are deliberately kept out of `apps/web/src` so they never ship.

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 11 |
| Checked (done) | 11 |
| Current-cutoff blockers (unchecked) | 0 |
| Accepted/deferred follow-up | 3 (all deferred, none opened) |
| Superseded/obsolete | 0 |

## Current Cutoff

### M1 - Streaming-markdown re-lex profiling gate (4)

- [x] RED: benchmark + pass criteria defined - 2/8/20/50KB messages over realistic ~24B streaming
      deltas; measure per-frame `markdownParts` lex+DOMPurify cost; threshold = coalesced per-frame
      parse routinely blowing the ~16ms frame budget at lengths Belay actually streams.
- [x] GREEN: harness built (`artifacts/markdown-relex-bench.ts`, faithful `markdownParts` replica) and
      run; numbers recorded below.
- [x] GREEN: Streamdown comparison recorded (documented complexity + on-disk bundle argument; needs a
      real built-chunk delta on the dev machine).
- [x] Decision: **keep-as-is / NO-GO on Streamdown**; incremental-parse-in-place is the cheaper
      Belay-owned alternative if a browser profile ever proves a real length threshold. Follow-up
      deferred, not opened.

### M2 - Read-only ExternalStore adapter spike (4)

- [x] RED: render-cost comparison + correctness checks (thread-id sync, immutability) defined.
- [x] GREEN: read-only scaffold built (`artifacts/external-store-adapter-spike.tsx` +
      `.stories.tsx`); typechecks clean against `@assistant-ui/react@0.14.23` (verified via temp copy
      into `apps/web/src/session` + `tsgo --noEmit`).
- [x] GREEN: render-cost + thread-id-sync + `isRunning` + useShallow/structural-sharing observations
      recorded below.
- [x] Decision: **viable but non-cheaper bridge** (converter + re-introduced sync hazard); adapt-only,
      deferred. Feeds M3.

### M3 - Persistence / thread-adapter mapping study (3)

- [x] RED: two target shapes separated (render `ThreadMessageLike` vs persistence
      `{id,parent_id,format,content}`); lossless-storage vs lossy-view defined.
- [x] GREEN: all 18 Belay row kinds mapped; 9 have no native part type; init-before-first-append race
      checked (Belay's `append` self-initializes via `ensureSession`, so no race).
- [x] Decision: **lossless as storage bytes, LOSSY as a primitives view**; no adoption implied.

---

## Findings

### M1 - re-lex profiling (D2)

Belay re-lexes+re-sanitizes the WHOLE message every settled frame (`markdown.tsx:186`
`markdownParts(deferredText)` -> `marked.lexer` -> `marked.parser` -> `DOMPurify.sanitize`), O(len^2)
over a turn. Harness `artifacts/markdown-relex-bench.ts` (run from `apps/web`: `cp` it there as
`__relex-bench.mts`, `npx tsx`, delete). Measured (jsdom+tsx, one parse per settled prefix = upper bound):

| size | frames | turn total ms | mean/frame ms | median/frame ms | final one-shot ms |
|------|--------|---------------|---------------|-----------------|-------------------|
| 2KB  | 87     | 36.6          | 0.42          | 0.45            | 0.66 |
| 8KB  | 342    | 445.3         | 1.30          | 1.21            | 2.24 |
| 20KB | 858    | 2607.0        | 3.04          | 3.05            | 5.28 |
| 50KB | 2134   | 23510.2       | 11.02         | 8.14            | 20.76 |

Scaling vs 2KB: 8KB=3.1x cost/length, 20KB=7.2x, 50KB=26.1x -> the O(len^2) signature confirmed. The
single settled parse is cheap even at 50KB (~21ms); the pain is only the streaming path at large sizes,
where `useDeferredValue` coalescing already keeps per-frame cost <1.3ms up to 8KB and ~3ms at 20KB.

TIMING CAVEAT (per plan): headless jsdom+tsx ms are NOT authoritative for the browser. Trust the SHAPE
(super-linear per-turn growth) and cross-size RELATIVE cost. **Still needs a real run:** authoritative
absolute per-frame ms (Storybook `MarkdownBody` streamed through the Performance panel / long-task
counts) and a real `pnpm add streamdown` + `pnpm --filter web build` chunk-size delta, both on the dev
machine.

Streamdown = block-incremental parse (re-parses only the tail block) -> ~O(len); but bundles a NEW Shiki
engine (not installed) + KaTeX (already transitive) + Mermaid (already a dep), beside Belay's tuned lazy
highlight.js. Not justified for Belay's single-digit-KB typical answers. Cheaper alt: memoize settled
leading blocks inside `markdownParts` (Belay-owned, no new engine).

### M2 - ExternalStore adapter (E4/A14)

Scaffold: read-only `useExternalStoreRuntime({ isRunning:false, messages: toTranscript(log),
convertMessage, onNew: throws })` over ONE captured session, under `AssistantRuntimeProvider` +
`ThreadPrimitive`. Observations:

1. The converter defeats Belay's per-row structural sharing (projector `dirty`-set identities feeding
   `React.memo`, transcript.ts:527) unless it carries its own per-row identity cache - it ADDS a layer
   to reach parity the projector already provides (audit E4: "neutral-to-negative unless it replaces,
   not layers on, existing memoization").
2. Thread-id-sync footgun is real and already solved Belay-side: `createSessionReadModel` substitutes
   `NO_EVENTS` when the log still holds the previous session (projection.ts:90). An ExternalStore layer
   sits at that exact boundary and would need `messages` + `threadList.threadId` to flip atomically or
   render the old thread under the new id - re-introducing the race with no simplification.
3. `isRunning` must be fed from Belay (`awaitingResponse`/`activeRunId`), not assistant-ui's
   last-message heuristic, or running state drifts.

Decision: viable-but-non-cheaper bridge (converter + sync hazard on top of an already-memoized
projector); adapt-only, deferred.

### M3 - mapping study (A16/A17/E8)

Two shapes: render `ThreadMessageLike` (roles user|assistant|system + closed part set + `data-*`
escape hatch) vs persistence `{id,parent_id,format,content}` (opaque `content`). Storage is lossless
(any row serializes into opaque content, incl. `data-belay-*`). The primitives VIEW is lossy:

- Lossless core (3): user, assistant (text+reasoning), tool (tool-call part).
- Semi-lossy (5): result (menu payload unrepresentable), delegation, inlineAgent, shell, lucid.
- No native part type -> `data-belay-*` custom parts stock primitives ignore (9): recovered, continued,
  reconnecting, guardrail, compacting, question, hookDecision, modelSwitch, limit.
- Plus the assistant row's usage/breakdown/stop/stepLimit/diagnostic have no first-class field
  (-> `metadata.custom`).

Init-before-first-append race (E8): NONE in Belay. Store `append` (log.ts:388) calls idempotent
`ensureSession` synchronously before computing seq/inserting (node:sqlite serial), so the session record
self-initializes on first append - no separate create-thread round-trip to race. Confirms E8
`keep-belay-owned`.

Decision: adapter is a lossless STORE but a LOSSY VIEW (9/18 kinds + assistant metadata have no native
part); rendering Belay's real UI through assistant-ui would mean rebuilding ~half the taxonomy as
bespoke data-part components. No adoption implied.

## Accepted/Deferred Follow-Up

All deferred; NONE opened (research-only). Inputs for future plans:

1. (D2) "Block-incremental markdown parse for large streaming turns" - gated on a real-browser profile
   proving a concrete length where coalesced per-frame parse exceeds one frame for real content.
   Smallest slice: memoize settled leading blocks in `markdownParts`. Belay-owned; no Streamdown.
2. (E4/A14) Any ExternalStore adapter must (a) replace, not layer on, the existing row memoization, and
   (b) carry the sessionId/threadId atomicity guard from projection.ts:90. Only worth it for access to
   stock primitives Belay mostly already exceeds.
3. (A16) Any adoption must accept that ~half of Belay's row kinds project only as custom data parts
   (lossy view), not stock primitives.

## Superseded/Obsolete Checklist Debt

None.
