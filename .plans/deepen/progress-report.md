# Deepen Backlog — Progress Report

> Scope: tracks the status of every deepening candidate (C-01…C-60) found by the 5-pass deepen audit
> (full detail + evidence in `implementation.md`). Each candidate is acted on SEPARATELY — pick one,
> run `planner` with it as the brief to redesign, land + verify, then `observability` to instrument the
> new boundary — and check its box here when that redesign has shipped. This is a backlog tracker, not
> a sequential plan; candidates within a rank are independent and may be done in any order.
> Current focus: High C-01 packages/session — events/decode/DecodedEvent triple spelled 3× → one descriptor table

## Summary

- Total candidates: 60 (High 19 · Medium 23 · Low 18)
- Acted on (redesigned, landed, verified): 0
- Pending: 60
- Subsumed: C-31 → C-56 (do C-31 as part of the C-56 resolver, or as the trivial standalone quick win)

## High

- [ ] **C-01** packages/session — events/decode/DecodedEvent triple spelled 3× → one descriptor table
- [ ] **C-02** agent-host/main.ts — 24-arm command-dispatch ladder → CommandRegistry actions
- [ ] **C-03** agent-host/main.ts — workspace-switch blocker+switch dup ×4 → guardedWorkspaceSwitch
- [ ] **C-04** agent-host — compaction-controller fold-arg assembly leaked → planFold
- [ ] **C-05** agent-host/providers — default-reasoning ladder rewritten ×4 → defaultReasoningLevel
- [ ] **C-06** agent-host/providers — provider-failure-log pass-through wrapper → drop it
- [ ] **C-07** web/App.tsx — model/reasoning resolution + duplicate reasoning store → into useModelSelection
- [ ] **C-08** packages/session — GET /sessions missing from SessionTransport (3 callers) → fetchInventory
- [ ] **C-09** packages/session — /sessions route path vocabulary ×3 → sessionRoutes descriptor
- [ ] **C-29** cross-pkg — chars→token estimate DRIFT (host vs web) → session helpers **[fixes a bug]**
- [ ] **C-30** cross-pkg — blob client/server contract hand-synced → @trevor/session blob-contract leaf
- [ ] **C-34** agent-host — ProviderUnavailable evidence projection ×4 → providerFailureEvidence
- [ ] **C-37** web — token/ctx display-formatter drift (SidePanel/chooser) → use derive fmtTokens/fmtCtx
- [ ] **C-38** web — SourceAction label drift ("Refresh catalog"/"Refresh") → sourceActionMeta
- [ ] **C-43** agent-host/recall/engine.ts — result envelope (diagnostics/activity/status) → builder seam
- [ ] **C-44** agent-host/context — ignored-dir tree-walk duplicated ×2 → walkContextTree
- [ ] **C-48** agent-host/loop.ts — budget→gate pair + live-fact bag ×2 → TurnGovernor
- [ ] **C-52** tests — SessionEvent envelope hand-spelled ×12 → storedEvent / storedLog helper
- [ ] **C-53** tests — hermetic-server boot re-rolled ×8 → bootStore / bootBlob helper

## Medium

- [ ] **C-10** agent-host/main.ts — control-prompt shape rebuilt ×3 → controlPrompt()
- [ ] **C-11** agent-host/main.ts — auto-resume / trailing-turn log projection stranded → resume-projection
- [ ] **C-12** agent-host — msg() bypassed by 2 modules → route through msg
- [ ] **C-13** agent-host/providers — construction split (buildProviders vs buildSourceProvider) → source registry
- [ ] **C-14** agent-host/doctor — readiness→status + probe shapers duplicated → probeProviderStatus
- [ ] **C-15** agent-host/skills — discoverSkills + buildSkillRegistry double-walk → single walk
- [ ] **C-16** agent-host/skills — description-split format ×3 → splitDescription
- [ ] **C-17** web — ToolMessage→ToolStatus mapping ×3 divergent → toolMessageStatus **[fixes a bug]**
- [ ] **C-18** web/derive.ts — project/workspace-name derivation duplicated → projectName
- [ ] **C-19** packages/session — provider-question normalize vs decode duplicated → coercion core
- [ ] **C-20** trevor-cli — lifecycleIo/hostControlIo re-wire + processAlive dup → build once / reuse
- [ ] **C-31** agent-host/main.ts — port 17424 literal → RESERVED_PORTS.store *(subsumed by C-56)*
- [ ] **C-32** cross-pkg — /health contract dup (server-kit vs cli) → export from server-kit
- [ ] **C-35** agent-host — offered-tool-def set computed ×2 (turn vs loop) → offeredToolDefs
- [ ] **C-39** web — transcript-row-view tone-coded Alert ×6 → ToneAlert primitive
- [ ] **C-40** web/App.tsx — toConcurrentTool projection (App-resident + drilled) → into transcript model
- [ ] **C-45** agent-host/context — RuleCollector re-walked per file-touch/turn → cached collector
- [ ] **C-49** agent-host/turn.ts — prompt-overhead formula dup (turn vs pi-ai) → promptOverheadChars
- [ ] **C-50** agent-host — turn-stop sink split + double-projected → recordTurnStop
- [ ] **C-54** tests — in-memory SessionTransport double ×4 → recordingTransport factory
- [ ] **C-55** tests/web — DoctorSnapshot/Area fixtures ×5 → doctorSnapshot/doctorArea
- [ ] **C-56** cross-pkg — service-URL construction ×8 → serviceUrl(name, env) *(subsumes C-31)*
- [ ] **C-58** cross-pkg — GitStatus ref-label derivation (host vs web) → gitRefLabel

## Low

- [ ] **C-21** agent-host/main.ts — commandResult emission ×40 *(subsumed by C-02)*
- [ ] **C-22** agent-host/providers — protocol-anomaly rules differ by wording → one templated rule
- [ ] **C-23** agent-host/context — sources.ts speculative taxonomy → fold/drop unused kinds
- [ ] **C-24** web — useComposer→PromptInput 14-prop re-spread → pass the Composer object
- [ ] **C-25** packages/session — host.sourceAuth flat-spread vs nested decode → nest under a key
- [ ] **C-26** packages/test-kit — testTransport thin wrapper → drop it
- [ ] **C-27** stores — blob-store main bypasses startServer → route through it
- [ ] **C-28** stores — blob-store HEAD route has no client → add headBlob or drop
- [ ] **C-33** cross-pkg — host relative-time hand-roll → use session relativeTime
- [ ] **C-36** agent-host/loop.ts — provider-diagnostic cluster + withDiagnostic field-copy → beside taxonomy
- [ ] **C-41** web — formatElapsed vs formatToolDuration → one duration formatter
- [ ] **C-42** web — artifact image-partition filter dup → partitionArtifacts
- [ ] **C-46** agent-host — env→number parsers ×5 divergent → envNumber/envFlag
- [ ] **C-47** agent-host/context — scope-band precedence positional → SCOPE_PRECEDENCE
- [ ] **C-51** agent-host/loop.ts — per-step model-stream assembly ×2 → modelStep
- [ ] **C-57** tests — RecallRecord fixture ×3 → recallRecord helper
- [ ] **C-59** web/stories — Frame width-wrapper ×8 → shared Frame story helper
- [ ] **C-60** cross-pkg — unknown→message string ×5 (web/cli can't import host msg) → shared util

## Acting log

> Append one line per candidate as it ships: `C-NN — landed (<commit/PR>, <date>)`.

- (none yet)
