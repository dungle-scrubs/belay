# Transcript Mermaid Rendering - Implementation Plan

## 0. Hard Dependencies

- Existing `MarkdownBody` chat markdown boundary.
- Existing `apps/web/src/markdown.tsx` `marked` plus DOMPurify renderer.
- Existing `apps/web/src/components/chat/message.stories.tsx` Storybook message fixtures.
- Existing `apps/agent-host/src/providers/system-prompt.ts` centralized prompt guidance.
- Existing Lucid/artifact-panel plans as the richer artifact-iteration boundary.

## 1. Architecture

Trevor should render explicit fenced Mermaid blocks in transcript markdown while preserving source readability and safety. The near-term target is assistant messages first because that is where model-authored visual explanations naturally appear. Any later expansion to tool output, command output, or detail views should reuse the same component only after those surfaces opt in.

The renderer should recognize only fenced code blocks with language `mermaid`. Other code blocks stay normal code. Mermaid output is generated client-side inside a controlled component with a locked Mermaid config, sanitized output handling, render-error fallback to source, and Storybook coverage for common diagram types and failure states.

Prompt guidance should tell the model Mermaid is available and should be used proactively when it clarifies flows, state machines, sequence interactions, dependencies, or architecture relationships. The guidance must also define the boundary with Lucid: Mermaid is inline response explanation inside the transcript; Lucid is for artifact-backed plan/document iteration and user markup.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Render only explicit fenced `mermaid` blocks | Avoid guessing diagrams from arbitrary code or prose |
| Keep source fallback always available | Syntax errors and render failures remain readable |
| Lock Mermaid config and sanitize output path | Model-authored diagram source is untrusted |
| Lazy/deferred rendering | Transcript virtualization and streaming responsiveness stay intact |
| Mermaid and Lucid have separate jobs | Prompt guidance does not push all visual work into one surface |

### Boundaries

- `MarkdownBody` remains the chat markdown entry point.
- `markdown.tsx` or a small markdown-rendering seam owns language routing from fenced blocks.
- A dedicated Mermaid component owns rendering, loading, errors, zoom/source/copy controls, and accessibility labels.
- `system-prompt.ts` owns model guidance that Mermaid is available.
- Lucid/artifact-panel plans own reviewable, addressable artifacts; this plan only guides inline transcript diagrams.

### Observability

No host telemetry is required. Client-side render failures should be visible in the transcript and Storybook. Tests should cover render-error fallback and source-copy affordances so failures do not become blank blocks.

## 2. Phases

### Phase 1: Markdown Routing and Safe Rendering

**Goal:** Explicit Mermaid fenced blocks route to a safe component while ordinary code stays unchanged.

#### M1: Fenced-Block Detection

- **Dependencies:** hard dependencies
- **Effort:** M
- **Tasks:**
  1. RED: Add markdown tests for ` ```mermaid ` routing and ordinary fenced code staying a code block.
  2. GREEN: Add a renderer seam that detects normalized `mermaid` language only.
  3. RED: Cover case, whitespace, and info-string variants without false positives.
  4. GREEN: Pass raw Mermaid source into a React-owned component instead of injecting unsanitized SVG directly.
  5. RED: Verify non-Mermaid code-block copy behavior remains unchanged.
  6. REFACTOR: Keep markdown parsing and Mermaid rendering responsibilities separate.

#### M2: Mermaid Component

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add component tests for loading, rendered, syntax error, and unavailable-library states.
  2. GREEN: Render diagrams with a locked config, theme-token colors, and no arbitrary script execution.
  3. RED: Add tests for source fallback and copy-source control.
  4. GREEN: Show raw source fallback whenever rendering fails.
  5. RED: Verify reduced-motion and repeated rerenders do not duplicate SVG nodes.
  6. REFACTOR: Keep generated IDs deterministic enough for tests without leaking cross-message collisions.

### Phase 2: Storybook and Transcript Polish

**Goal:** Mermaid diagrams are inspectable and stable in realistic transcript states.

#### M3: Storybook Coverage

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add Storybook states for flowchart, sequence, state/class-style diagram, syntax error, long/wide diagram, and narrow viewport.
  2. GREEN: Add responsive contained layout with horizontal overflow or zoom controls as needed.
  3. RED: Add dark theme and high-contrast visual checks.
  4. GREEN: Map Mermaid colors to Trevor tokens instead of one-off palette values.
  5. RED: Add streaming/incomplete-message story with skeleton or deferred render.
  6. REFACTOR: Keep diagram chrome aligned with existing code-block/card surfaces.

#### M4: Transcript Integration

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add message/assistant transcript tests for Mermaid diagrams mixed with prose and code.
  2. GREEN: Render diagrams in assistant messages without changing user-message markdown behavior unless explicitly reused.
  3. RED: Verify virtualized transcript row measurement settles after diagram render.
  4. GREEN: Avoid blocking initial transcript paint by deferring Mermaid rendering.
  5. REFACTOR: Keep fallback source visible enough for failures and copy/debug needs.

### Phase 3: Model Guidance and Surface Boundaries

**Goal:** The model knows Mermaid is available and uses it in the right situations without conflicting with Lucid.

#### M5: Prompt Guidance

- **Dependencies:** M4
- **Effort:** S
- **Tasks:**
  1. RED: Add system-prompt tests proving Mermaid guidance is present on tool and no-tool routes where transcript rendering is available.
  2. GREEN: Add concise guidance that Mermaid fenced blocks are supported and useful for flows, sequences, state machines, dependencies, and architecture relationships.
  3. RED: Add tests that the guidance does not mention Lucid as a callable tool unless it is actually available.
  4. GREEN: Define Mermaid as inline response explanation and Lucid/artifacts as reviewable external iteration surfaces.
  5. REFACTOR: Keep guidance in the centralized prompt builder rather than duplicating it across providers.

#### M6: E2E and Regression

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Add a web test or Storybook interaction that verifies diagram source fallback on invalid input.
  2. GREEN: Verify valid diagrams render without console errors.
  3. RED: Add regression coverage for ordinary code copy, tables, links, and GFM still rendering correctly.
  4. GREEN: Run the web project tests and the relevant system-prompt tests.
  5. REFACTOR: Document when to prefer Mermaid vs Lucid in plan notes or prompt comments.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Mermaid output creates an XSS path | high | medium | Locked config, no arbitrary script execution, DOMPurify/fallback review | web |
| Streaming partial diagrams flicker or error repeatedly | medium | medium | Defer rendering until block is stable or show skeleton while incomplete | web |
| Large diagrams break transcript layout | medium | medium | Responsive container, zoom/source controls, Storybook wide/narrow states | web |
| Prompt guidance overuses diagrams | medium | medium | Use "when it clarifies" guidance and preserve prose-first answers | host |
| Mermaid/Lucid boundary becomes confusing | medium | low | Explicit prompt and plan boundary: inline explanation vs reviewable artifact | host |

## 4. Escape Hatches

1. **If Mermaid render safety is uncertain:** keep fenced blocks as code and defer rendering until a safe configuration is proven.
2. **If streaming causes poor UX:** render Mermaid only after assistant segment completion and show the raw fenced block while streaming.
3. **If diagrams are too large for transcript:** keep transcript rendering compact and rely on source/copy or future detail/artifact views for deep inspection.

## 5. Progress Report Accounting

Progress lives in `.plans/19-transcript-mermaid-rendering/progress-report.md`. Count only active unchecked implementation tasks as blockers. Do not mark model-guidance work complete until the prompt tests prove the guidance and Lucid boundary.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "19-transcript-mermaid-rendering"
```

## 6. Validation Commands

```bash
pnpm --filter @trevor/web test -- --project web apps/web/src/markdown.test.tsx
pnpm --filter @trevor/web test -- --project web apps/web/src/components/chat/message.test.tsx
pnpm --filter @trevor/agent-host test -- apps/agent-host/src/providers/system-prompt.test.ts
pnpm --filter @trevor/web storybook
pnpm test -- --project web
```

## 7. Decisions

Canonical decisions live in `.plans/19-transcript-mermaid-rendering/plan.db`.
