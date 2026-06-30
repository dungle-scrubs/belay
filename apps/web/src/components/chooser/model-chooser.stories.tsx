import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CatalogEntry, SourceSummary } from "@trevor/session";
import { LM_STUDIO_LOCAL_ENTRIES } from "@trevor/test-kit/lmstudio";
import { ModelChooser } from "./model-chooser";

/**
 * D-065 M2: the full model chooser, Storybook-first. It takes over the transcript + prompt space while
 * the sidebars stay visible, so the stories frame it in a fixed-size panel. The frame uses INLINE pixel
 * dimensions (not Tailwind arbitrary widths) so the panel is sized reliably under the global centering
 * preview decorator. States cover wide, narrow, both-sidebars, long labels, empty, loading, stale,
 * error, and many sources. Fixtures are production-shaped `SourceSummary` / `CatalogEntry` read models.
 */

const meta: Meta<typeof ModelChooser> = {
  title: "Chooser/ModelChooser",
  component: ModelChooser,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof ModelChooser>;

function source(over: Partial<SourceSummary> & { sourceId: string }): SourceSummary {
  return {
    type: "local",
    label: `Source ${over.sourceId}`,
    status: "ready",
    modelCount: 3,
    auth: "authenticated",
    freshness: { refreshedAt: "2026-06-27T00:00:00.000Z", stale: false },
    actions: [],
    ...over,
  };
}

function entry(over: Partial<CatalogEntry> & { sourceId: string; modelId: string }): CatalogEntry {
  return {
    displayName: over.modelId,
    kind: "cloud",
    capabilities: ["tools"],
    contextLength: 128_000,
    costTier: "medium",
    aliases: [],
    freshness: { refreshedAt: "2026-06-27T00:00:00.000Z", stale: false },
    reasoningLevels: [],
    defaultReasoning: "off",
    ...over,
  };
}

const SOURCES: SourceSummary[] = [
  source({ sourceId: "lmstudio", label: "LM Studio", type: "local", modelCount: 4 }),
  source({
    sourceId: "ollama",
    label: "Ollama",
    type: "local",
    modelCount: 2,
    status: "unavailable",
    actions: ["configure"],
  }),
  source({
    sourceId: "codex",
    label: "OpenAI (Codex subscription)",
    type: "oauth",
    modelCount: 6,
    auth: "authenticated",
    actions: ["refresh"],
  }),
  source({
    sourceId: "anthropic-sub",
    label: "Anthropic (Claude subscription)",
    type: "oauth",
    modelCount: 5,
    status: "needs-auth",
    auth: "expired",
    actions: ["reauthenticate"],
  }),
  source({ sourceId: "anthropic-api", label: "Anthropic API key", type: "api-key", modelCount: 7 }),
  source({
    sourceId: "openai-api",
    label: "OpenAI API key",
    type: "api-key",
    modelCount: 9,
    status: "error",
    actions: ["configure"],
  }),
  source({
    sourceId: "openrouter",
    label: "OpenRouter gateway",
    type: "gateway",
    modelCount: 327,
    actions: ["refresh"],
    freshness: { refreshedAt: "2026-06-20T00:00:00.000Z", stale: true },
  }),
];

const CATALOG: Record<string, CatalogEntry[]> = {
  lmstudio: [
    entry({
      sourceId: "lmstudio",
      modelId: "qwen3-30b",
      displayName: "Qwen3 30B",
      kind: "local",
      capabilities: ["tools", "vision"],
      contextLength: 256_000,
      costTier: "free",
    }),
    entry({
      sourceId: "lmstudio",
      modelId: "llama-3.3-70b",
      displayName: "Llama 3.3 70B",
      kind: "local",
      capabilities: ["tools"],
      contextLength: 128_000,
      costTier: "free",
    }),
    entry({
      sourceId: "lmstudio",
      modelId: "deepseek-r1",
      displayName: "DeepSeek R1 Distill",
      kind: "local",
      capabilities: ["reasoning"],
      contextLength: 64_000,
      costTier: "free",
    }),
    entry({
      sourceId: "lmstudio",
      modelId: "gemma-3",
      displayName: "Gemma 3 27B",
      kind: "local",
      capabilities: ["tools", "vision"],
      contextLength: 96_000,
      costTier: "free",
      freshness: { refreshedAt: null, stale: true },
    }),
  ],
  openrouter: Array.from({ length: 40 }, (_, i) =>
    entry({
      sourceId: "openrouter",
      modelId: `model-${i}`,
      displayName: `Gateway Model ${i}`,
      capabilities: i % 2 === 0 ? ["tools", "vision"] : ["reasoning"],
      contextLength: 1_000_000,
      costTier: i % 3 === 0 ? "high" : "low",
    }),
  ),
};

const noop = () => {};

/** A fixed-size panel frame (inline px dimensions) so the chooser renders at a realistic takeover size
 *  under the centering preview decorator - independent of Tailwind arbitrary-width generation. */
function Panel({ children, width = 880 }: { children: React.ReactNode; width?: number }) {
  return (
    <div
      style={{ width, height: 660, flexShrink: 0 }}
      className="overflow-hidden rounded-lg border border-border"
    >
      {children}
    </div>
  );
}

export const Overview: Story = {
  render: () => (
    <Panel>
      <ModelChooser
        sources={SOURCES}
        catalogBySource={CATALOG}
        onSelectModel={noop}
        className="h-full"
      />
    </Panel>
  ),
};

/** The chooser between mock left/right sidebars, showing the container-query layout adapt to the
 *  space LEFT (the sidebars stay visible). */
export const BothSidebarsVisible: Story = {
  render: () => (
    <div
      style={{ width: 1160, height: 660, flexShrink: 0 }}
      className="flex overflow-hidden rounded-lg border border-border"
    >
      <div
        style={{ width: 224 }}
        className="shrink-0 border-r border-border bg-smui-surface-sunken p-3 text-label tracking-wider text-muted-foreground"
      >
        Left sidebar
      </div>
      <div className="min-w-0 flex-1">
        <ModelChooser
          sources={SOURCES}
          catalogBySource={CATALOG}
          onSelectModel={noop}
          className="h-full"
        />
      </div>
      <div
        style={{ width: 256 }}
        className="shrink-0 border-l border-border bg-smui-surface-sunken p-3 text-label tracking-wider text-muted-foreground"
      >
        Right panel
      </div>
    </div>
  ),
};

/** A deliberately narrow space after wide sidebars - the source grid drops to one column. */
export const NarrowAfterSidebars: Story = {
  render: () => (
    <div
      style={{ width: 1040, height: 660, flexShrink: 0 }}
      className="flex overflow-hidden rounded-lg border border-border"
    >
      <div
        style={{ width: 320 }}
        className="shrink-0 border-r border-border bg-smui-surface-sunken"
      />
      <div className="min-w-0 flex-1">
        <ModelChooser
          sources={SOURCES}
          catalogBySource={CATALOG}
          onSelectModel={noop}
          className="h-full"
        />
      </div>
      <div
        style={{ width: 320 }}
        className="shrink-0 border-l border-border bg-smui-surface-sunken"
      />
    </div>
  ),
};

export const LongLabels: Story = {
  render: () => (
    <Panel width={460}>
      <ModelChooser
        sources={[
          source({
            sourceId: "x",
            label:
              "A very long model-source label that should truncate instead of wrapping the row",
            type: "gateway",
            modelCount: 1200,
            actions: ["refresh"],
          }),
          source({ sourceId: "y", label: "Short", type: "local" }),
        ]}
        catalogBySource={{}}
        onSelectModel={noop}
        className="h-full"
      />
    </Panel>
  ),
};

export const ManySources: Story = {
  render: () => (
    <Panel>
      <ModelChooser
        sources={Array.from({ length: 18 }, (_, i) =>
          source({
            sourceId: `s${i}`,
            label: `Source ${i}`,
            type: (["local", "oauth", "api-key", "gateway"] as const)[i % 4],
            modelCount: (i + 1) * 7,
          }),
        )}
        catalogBySource={{}}
        onSelectModel={noop}
        className="h-full"
      />
    </Panel>
  ),
};

export const Loading: Story = {
  render: () => (
    <Panel>
      <ModelChooser
        sources={[]}
        catalogBySource={{}}
        loading
        onSelectModel={noop}
        className="h-full"
      />
    </Panel>
  ),
};

export const Empty: Story = {
  render: () => (
    <Panel>
      <ModelChooser sources={[]} catalogBySource={{}} onSelectModel={noop} className="h-full" />
    </Panel>
  ),
};

/**
 * Source detail (opened on LM Studio via `initialSourceId`): identity + status + action, search,
 * capability filters, and model rows (one stale, one selected). Click a model to select it; the back
 * arrow returns to the overview.
 */
export const SourceDetailOpen: Story = {
  render: () => (
    <Panel width={620}>
      <ModelChooser
        sources={SOURCES}
        catalogBySource={CATALOG}
        initialSourceId="lmstudio"
        activeModel={{ sourceId: "lmstudio", modelId: "llama-3.3-70b", reasoning: null }}
        onSelectModel={noop}
        className="h-full"
      />
    </Panel>
  ),
};

/**
 * Local catalog metadata (09.3 D-004): two quants of the SAME model (`qwen3.6-27b-mlx`) that differ
 * only by org prefix in the id are told apart by the quantization + native context the catalog now
 * carries (8bit · 262k vs 4bit · 66k), and a VLM finally shows its Vision chip.
 */
export const LocalQuantsDisambiguated: Story = {
  render: () => (
    <Panel width={620}>
      <ModelChooser
        sources={[
          source({ sourceId: "lmstudio", label: "LM Studio", type: "local", modelCount: 3 }),
        ]}
        // The same shared fixture the chooser + integration tests assert against, so the visual and
        // the test agree on exactly what the catalog derives from the LM Studio native record.
        catalogBySource={{ lmstudio: LM_STUDIO_LOCAL_ENTRIES }}
        initialSourceId="lmstudio"
        onSelectModel={noop}
        className="h-full"
      />
    </Panel>
  ),
};
