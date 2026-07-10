# Progress Report - Assistant-UI Audit Research Spikes

**Plan:** `58.6.3-audit-research-spikes`
**Stage:** ready for implementation
**Current focus:** M1 - Streaming-markdown re-lex profiling gate (4)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 11 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 11 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

## Current Cutoff

### M1 - Streaming-markdown re-lex profiling gate (4)

- [ ] RED: Define the benchmark + pass criteria - a 20KB message in realistic deltas;
      per-frame `markdownParts` CPU (lex + DOMPurify) at 2/8/20/50KB; the threshold
      where whole-text re-lex would justify a second engine's bundle.
- [ ] GREEN: Build a throwaway harness (Storybook story or profiling script) over the
      delta sequence; record numbers.
- [ ] GREEN: Compare against Streamdown's incremental parse (measured or documented) +
      its bundle delta.
- [ ] Decision: record adopt-Streamdown / incremental-parse-in-place / keep-as-is with
      the evidence; open or close a follow-up.

### M2 - Read-only ExternalStore adapter spike (4)

- [ ] RED: Define the render-cost comparison + correctness checks (thread-id sync,
      immutability) that decide "viable bridge vs converter + sync hazard."
- [ ] GREEN: Build a Storybook-only read-only ExternalStore adapter mirroring
      `SessionReadModel` for one captured session; no intents.
- [ ] GREEN: Measure render cost vs current rows; document the thread-id-sync footgun
      and useShallow re-render behavior.
- [ ] Decision: record whether it is a viable bridge to assistant-ui primitives; feeds M3.

### M3 - Persistence / thread-adapter mapping study (3)

- [ ] RED: Enumerate every Trevor row/event kind + the `{id,parent_id,format,content}`
      target; define lossless vs lossy view.
- [ ] GREEN: Map each kind; flag which need custom data parts / have no representation;
      check the initialize-before-first-append race guard on session-create.
- [ ] Decision: record bridge-vs-lossy-view and the concrete losses for a future
      adoption plan.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.
