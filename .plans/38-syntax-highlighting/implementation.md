# Syntax Highlighting - Implementation Plan

## 0. Hard Dependencies

- Existing `apps/web/src/markdown.tsx` `marked` plus DOMPurify markdown renderer.
- Existing `apps/web/src/markdown.css` code-block structure and SMUI overrides.
- Existing `apps/web/src/markdown.test.tsx` coverage for table wrapping, copy buttons, and dedent/copy behavior.
- Existing `.plans/36-transcript-mermaid-rendering` language-route contract for fenced `mermaid` blocks.
- Existing chat message Storybook fixtures for realistic transcript markdown states.

## 1. Architecture

Trevor currently renders fenced code blocks through a custom `marked` renderer that dedents code, normalizes the displayed trailing newline, preserves a copy button, and sanitizes the final HTML with DOMPurify before it reaches the DOM. Syntax highlighting should upgrade that code-block presentation without weakening those guarantees.

The first implementation target is markdown code blocks in transcript surfaces that go through `MarkdownBody` and `Markdown`. Tool outputs and diff viewers can reuse the same highlighter later only if their renderers opt in. Fenced `mermaid` remains a separate language route owned by `.plans/36-transcript-mermaid-rendering`; syntax highlighting must not consume it.

The assistant-ui syntax highlighting reference points toward Shiki-style highlighting with dynamic language support and skipping expensive tokenization while content is still streaming. Trevor should adapt that policy to its current renderer: explicit fenced languages first, safe fallback for unknown/no language blocks, copy behavior unchanged, and Storybook/test coverage before broad reuse.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Preserve code-block copy exactly | The copied text remains dedented source, not highlighted markup |
| Preserve DOMPurify/safe rendering | Highlighted output cannot introduce unsafe HTML |
| Mermaid is excluded from syntax highlighting | Plan 36 owns Mermaid rendering and fallback |
| No initial language guessing | Only explicit fenced languages highlight in the first cut |
| Highlighting must not block streaming transcript updates | Defer, cache, or skip while unstable as needed |

### Boundaries

- `Markdown` owns markdown fenced code handling.
- A highlighter helper/component owns language normalization, grammar loading, fallback rendering, and token styling.
- `markdown.css` owns structural code-block layout and can receive token-color classes/variables.
- Mermaid routing remains separate from syntax highlighting.
- Tool output, diff output, and terminal blocks are future opt-in consumers, not part of the first implementation.

### Observability

No host/runtime observability is required. Browser tests should prove language selection, fallback behavior, copy preservation, and sanitization. Storybook should cover visual regressions across dark/narrow/long/wide states.

## 2. Phases

### Phase 1: Highlighter Selection and Safe Boundary

**Goal:** The markdown renderer can highlight known fenced languages while preserving existing HTML safety and copy behavior.

#### M1: Renderer Contract Tests

- **Dependencies:** hard dependencies
- **Effort:** M
- **Tasks:**
  1. RED: Extend markdown tests for `ts`, `tsx`, `bash`, `json`, `diff`, unknown language, no language, and `mermaid` exclusion.
  2. GREEN: Add language normalization and highlighter routing behind the existing code-block renderer.
  3. RED: Verify copy button copies the original dedented source for highlighted and non-highlighted blocks.
  4. GREEN: Keep copy text generation independent from highlighted markup.
  5. RED: Add a sanitization regression with suspicious code content.
  6. REFACTOR: Keep dedent/normalize/copy helpers pure and separately testable where useful.

#### M2: Highlight Engine Integration

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add tests or fixtures proving fallback when the highlighter or grammar is unavailable.
  2. GREEN: Integrate a Shiki-style highlighter or equivalent React-safe token renderer for explicit languages.
  3. RED: Verify unknown/no-language blocks retain current plain code rendering.
  4. GREEN: Load only needed grammars/themes where practical.
  5. RED: Verify highlighted markup uses token classes/styles compatible with DOMPurify or avoids raw HTML entirely.
  6. REFACTOR: Avoid global highlighter initialization in render paths that can run frequently.

### Phase 2: Transcript UX and Storybook

**Goal:** Highlighted code blocks look correct in Trevor chat surfaces and do not regress markdown layout.

#### M3: Visual States

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add Storybook states for TypeScript, TSX, shell, JSON, diff, unknown, no language, long/wide code, and mixed prose/code.
  2. GREEN: Apply token colors that work with Trevor/SMUI dark surfaces and muted reasoning surfaces.
  3. RED: Add narrow viewport and high-contrast stories/checks.
  4. GREEN: Keep code blocks horizontally scrollable without text overlap or copy-button collision.
  5. RED: Add dark theme checks for contrast and selection readability.
  6. REFACTOR: Keep code-block chrome consistent with existing copy button and planned custom scrollbar styling.

#### M4: Streaming and Performance

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add tests/stories for streaming or partial code blocks where highlighting is deferred/skipped.
  2. GREEN: Do not run expensive tokenization on unstable streaming content if it causes churn.
  3. RED: Verify very long code blocks do not freeze the transcript or virtualized list.
  4. GREEN: Cache highlighted output by language and source where appropriate.
  5. REFACTOR: Keep performance policy local to markdown rendering so tool renderers are unaffected.

### Phase 3: Regression and Future Reuse Contract

**Goal:** Syntax highlighting is safe to ship for transcript markdown and has clear future reuse rules.

#### M5: Regression Suite

- **Dependencies:** M4
- **Effort:** S
- **Tasks:**
  1. RED: Add regression coverage for GFM tables, links, inline code, blockquotes, and code-copy behavior after highlighting.
  2. GREEN: Keep all existing markdown behavior intact.
  3. RED: Add tests proving `mermaid` remains routed/fallback-owned by plan 36 behavior.
  4. GREEN: Document language-route precedence: Mermaid first, syntax highlighter second, plain fallback third.
  5. REFACTOR: Document future opt-in requirements for tool outputs/diffs before reuse.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Highlighted HTML bypasses sanitization | high | medium | Prefer React/token nodes or sanitize highlighted HTML; add XSS regressions | web |
| Copy behavior drifts from displayed source | high | low | Keep copy text generated from dedented source before highlighting | web |
| Mermaid blocks get highlighted instead of rendered | medium | medium | Explicit language precedence tests | web |
| Highlighter bundle/runtime is heavy | medium | medium | Dynamic grammar loading, caching, explicit languages only | web |
| Streaming code blocks flicker | medium | medium | Skip/defer highlight while content is unstable | web |

## 4. Escape Hatches

1. **If Shiki is too heavy initially:** ship a smaller explicit-language highlighter for common languages and keep unknowns plain.
2. **If safe highlighted HTML is awkward with DOMPurify:** render tokens as React nodes instead of raw highlighted HTML.
3. **If streaming performance regresses:** highlight only completed assistant segments and keep active streaming blocks plain.

## 5. Progress Report Accounting

Progress lives in `.plans/38-syntax-highlighting/progress-report.md`. Count only active unchecked implementation tasks as blockers. Do not mark a milestone complete unless copy behavior, sanitization, and Mermaid precedence are covered.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "38-syntax-highlighting"
```

## 6. Validation Commands

```bash
pnpm --filter @trevor/web test -- --project web apps/web/src/markdown.test.tsx
pnpm --filter @trevor/web test -- --project web apps/web/src/components/chat/message.test.tsx
pnpm --filter @trevor/web storybook
pnpm test -- --project web
```

## 7. Decisions

Canonical decisions live in `.plans/38-syntax-highlighting/plan.db`.
