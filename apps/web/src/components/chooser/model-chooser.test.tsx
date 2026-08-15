import assert from "node:assert/strict";
import { type CatalogEntry, type ModelRef, modelRefKey, type SourceSummary } from "@belay/session";
import { LM_STUDIO_LOCAL_ENTRIES } from "@belay/test-kit/lmstudio";
import { fireEvent, render, within } from "@testing-library/react";
import { test } from "vitest";
import { ModelChooser } from "./model-chooser";

/**
 * D-065 M2: the full model chooser. Pins the grouped source overview, click-through to a source detail
 * with back navigation, source status/count/action rendering, the detail search + capability filters
 * over the host catalog, and that selecting a model emits a stable `{ sourceId, modelId, reasoning }`
 * ref - over production-shaped `SourceSummary` / `CatalogEntry` read models, not story-only data.
 */

function source(over: Partial<SourceSummary> & { sourceId: string }): SourceSummary {
  return {
    type: "local",
    label: `Source ${over.sourceId}`,
    status: "ready",
    modelCount: 2,
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
    capabilities: [],
    contextLength: 128_000,
    costTier: null,
    aliases: [],
    freshness: { refreshedAt: "2026-06-27T00:00:00.000Z", stale: false },
    reasoningLevels: [],
    defaultReasoning: "off",
    ...over,
  };
}

const SOURCES: SourceSummary[] = [
  source({ sourceId: "lmstudio", label: "LM Studio", type: "local", modelCount: 3 }),
  source({
    sourceId: "codex",
    label: "OpenAI (Codex)",
    type: "oauth",
    modelCount: 5,
    actions: ["reauthenticate"],
    auth: "expired",
    status: "needs-auth",
  }),
  source({ sourceId: "anthropic-api", label: "Anthropic API", type: "api-key", modelCount: 4 }),
  source({
    sourceId: "openrouter",
    label: "OpenRouter",
    type: "gateway",
    modelCount: 300,
    actions: ["refresh"],
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
    }),
    entry({
      sourceId: "lmstudio",
      modelId: "llama-3.3",
      displayName: "Llama 3.3",
      kind: "local",
      capabilities: ["tools"],
    }),
    entry({
      sourceId: "lmstudio",
      modelId: "deepseek-r1",
      displayName: "DeepSeek R1",
      kind: "local",
      capabilities: ["reasoning"],
    }),
  ],
};

const noop = () => {};

test("the overview groups sources by family with section headings", () => {
  const { getByRole } = render(
    <ModelChooser sources={SOURCES} catalogBySource={CATALOG} onSelectModel={noop} />,
  );
  // Each family heading is present, and its source sits under it.
  for (const label of ["Local runtimes", "Cloud subscriptions", "Direct API", "Gateway catalogs"]) {
    const section = getByRole("region", { name: label });
    assert.ok(section, `the ${label} section renders`);
  }
  const local = getByRole("region", { name: "Local runtimes" });
  assert.ok(within(local).getByText("LM Studio"), "LM Studio is under Local runtimes");
});

test("a source row shows status summary, count, and its available action; the row is a click-through", () => {
  const { getByLabelText } = render(
    <ModelChooser sources={SOURCES} catalogBySource={CATALOG} onSelectModel={noop} />,
  );
  const row = getByLabelText("Open LM Studio");
  assert.ok(within(row).getByText("3 models"), "the model count summary renders");

  // A needs-auth source shows its action affordance + the sign-in-expired summary.
  const codex = getByLabelText("Open OpenAI (Codex)");
  assert.ok(within(codex).getByText("Re-authenticate"), "the available action label renders");
  assert.ok(within(codex).getByText("sign-in expired"), "the host status summary renders");
});

test("clicking a source opens its detail view; back returns to the overview", () => {
  const { getByLabelText, queryByLabelText, getByText } = render(
    <ModelChooser sources={SOURCES} catalogBySource={CATALOG} onSelectModel={noop} />,
  );
  fireEvent.click(getByLabelText("Open LM Studio"));
  // The detail header shows the source identity + a search box.
  assert.ok(getByLabelText("Search models"), "the detail search renders");
  assert.ok(getByText("Qwen3 30B"), "the source's models render in detail");
  // The overview rows are gone.
  assert.equal(queryByLabelText("Open Anthropic API"), null, "the overview is replaced by detail");

  fireEvent.click(getByLabelText("Back to sources"));
  assert.ok(getByLabelText("Open Anthropic API"), "back returns to the grouped overview");
});

test("the detail search filters model rows over the host catalog", () => {
  const { getByLabelText, getByText, queryByText } = render(
    <ModelChooser sources={SOURCES} catalogBySource={CATALOG} onSelectModel={noop} />,
  );
  fireEvent.click(getByLabelText("Open LM Studio"));
  fireEvent.change(getByLabelText("Search models"), { target: { value: "llama" } });
  assert.ok(getByText("Llama 3.3"), "the matching model stays");
  assert.equal(queryByText("Qwen3 30B"), null, "non-matching models are filtered out");
});

test("a capability filter chip narrows the model rows", () => {
  const { getByLabelText, getByRole, getByText, queryByText } = render(
    <ModelChooser sources={SOURCES} catalogBySource={CATALOG} onSelectModel={noop} />,
  );
  fireEvent.click(getByLabelText("Open LM Studio"));
  // Only DeepSeek R1 has the "reasoning" capability.
  fireEvent.click(getByRole("button", { name: "reasoning" }));
  assert.ok(getByText("DeepSeek R1"), "the reasoning-capable model stays");
  assert.equal(queryByText("Llama 3.3"), null, "models without the capability are filtered out");
});

test("selecting a model emits a stable { sourceId, modelId, reasoning } ref", () => {
  const picked: ModelRef[] = [];
  const { getByLabelText } = render(
    <ModelChooser
      sources={SOURCES}
      catalogBySource={CATALOG}
      onSelectModel={(ref) => picked.push(ref)}
    />,
  );
  fireEvent.click(getByLabelText("Open LM Studio"));
  fireEvent.click(getByLabelText("Select Qwen3 30B"));
  assert.deepEqual(picked, [{ sourceId: "lmstudio", modelId: "qwen3-30b", reasoning: null }]);
});

// The host-derived local entries (two same-id quants + a VLM) from the shared 09.3 fixture, exactly as
// the catalog produces them from the LM Studio native record - so the chooser is tested over the real
// derived shape, not chooser-only data.
const LOCAL_SOURCE = [source({ sourceId: "lmstudio", label: "LM Studio", type: "local" })];
const LOCAL_CATALOG: Record<string, readonly CatalogEntry[]> = {
  lmstudio: LM_STUDIO_LOCAL_ENTRIES,
};

test("two same-id local quants render distinctly with quantization + context (D-004)", () => {
  // The two qwen3.6-27b-mlx quants differ only by org prefix in the id; quantization + context make
  // them tell-apart-able in the row (the motivating bug).
  const { getByLabelText } = render(
    <ModelChooser sources={LOCAL_SOURCE} catalogBySource={LOCAL_CATALOG} onSelectModel={noop} />,
  );
  fireEvent.click(getByLabelText("Open LM Studio"));

  const row8 = getByLabelText("Select unsloth/qwen3.6-27b-mlx");
  assert.ok(within(row8).getByText("8bit"), "the 8-bit quant labels its row");
  assert.ok(within(row8).getByText("262k ctx"), "its native context renders");

  const row4 = getByLabelText("Select lmstudio-community/qwen3.6-27b-mlx");
  assert.ok(within(row4).getByText("4bit"), "the 4-bit quant labels its row");
  assert.ok(within(row4).getByText("66k ctx"), "its smaller native context renders");
});

test("capability filters match the live local capabilities (tools/vision derived from the runtime)", () => {
  // The fixture carries a VLM (vision, no tools) and tool LLMs (tools, no vision), as the native record
  // derives them.
  const { getByLabelText, getByRole, getByText, queryByText } = render(
    <ModelChooser sources={LOCAL_SOURCE} catalogBySource={LOCAL_CATALOG} onSelectModel={noop} />,
  );
  fireEvent.click(getByLabelText("Open LM Studio"));

  // The Vision filter keeps only the VLM (its live vision capability), drops the tool LLM.
  fireEvent.click(getByRole("button", { name: "vision" }));
  assert.ok(getByText("qwen/qwen3-vl-8b"), "the VLM stays under the Vision filter");
  assert.equal(queryByText("unsloth/qwen3.6-27b-mlx"), null, "the non-vision model drops out");

  // Switch to the Tools filter: now only the tool LLM (which lacks vision) remains.
  fireEvent.click(getByRole("button", { name: "vision" }));
  fireEvent.click(getByRole("button", { name: "tools" }));
  assert.ok(getByText("unsloth/qwen3.6-27b-mlx"), "the tool model stays under the Tools filter");
  assert.equal(queryByText("qwen/qwen3-vl-8b"), null, "the no-tools VLM drops out");
});

test("the active model is marked selected in the detail list", () => {
  const active: ModelRef = { sourceId: "lmstudio", modelId: "llama-3.3", reasoning: null };
  const { getByLabelText } = render(
    <ModelChooser
      sources={SOURCES}
      catalogBySource={CATALOG}
      activeModel={active}
      onSelectModel={noop}
    />,
  );
  fireEvent.click(getByLabelText("Open LM Studio"));
  assert.equal(
    getByLabelText("Select Llama 3.3").getAttribute("aria-pressed"),
    "true",
    "the active model row is pressed/selected",
  );
  assert.equal(getByLabelText("Select Qwen3 30B").getAttribute("aria-pressed"), "false");
});

test("the source-detail auth/setup action invokes the host-owned flow", () => {
  const actions: [string, string][] = [];
  const { getByLabelText, getByRole } = render(
    <ModelChooser
      sources={SOURCES}
      catalogBySource={{}}
      onSelectModel={noop}
      onSourceAction={(id, action) => actions.push([id, action])}
    />,
  );
  fireEvent.click(getByLabelText("Open OpenAI (Codex)"));
  fireEvent.click(getByRole("button", { name: "Re-authenticate" }));
  assert.deepEqual(actions, [["codex", "reauthenticate"]]);
});

test("the Configure button on a source needing setup forwards onSourceAction(id, 'configure') (53 D-003)", () => {
  // The Anthropic Direct API source needs a key -> its detail shows the SourceAuthPanel with a
  // Configure action. The chooser forwards it; the App wires it to a defined effect (no dead button).
  const actions: [string, string][] = [];
  const anthropicDirect = source({
    sourceId: "anthropic-api",
    label: "Anthropic Direct API",
    type: "api-key",
    status: "needs-auth",
    auth: "none",
    modelCount: 0,
    actions: ["configure"],
  });
  const { getByLabelText, getByRole } = render(
    <ModelChooser
      sources={[anthropicDirect]}
      catalogBySource={{}}
      onSelectModel={noop}
      onSourceAction={(id, action) => actions.push([id, action])}
    />,
  );
  fireEvent.click(getByLabelText("Open Anthropic Direct API"));
  fireEvent.click(getByRole("button", { name: "Configure" }));
  assert.deepEqual(actions, [["anthropic-api", "configure"]]);
});

test("the Configured only toggle hides needs-setup sources", () => {
  // SOURCES has the needs-auth Codex source, so the toggle appears; toggling it hides Codex.
  const { getByText, getByLabelText, queryByLabelText } = render(
    <ModelChooser sources={SOURCES} catalogBySource={CATALOG} onSelectModel={noop} />,
  );
  assert.ok(getByLabelText("Open OpenAI (Codex)"), "the needs-auth source shows by default");
  fireEvent.click(getByText("Configured only"));
  assert.equal(
    queryByLabelText("Open OpenAI (Codex)"),
    null,
    "the needs-auth source is hidden when Configured only is on",
  );
  assert.ok(getByLabelText("Open LM Studio"), "configured sources remain");
});

test("the Configured only toggle is absent when every source is configured (no-op control)", () => {
  const configured = SOURCES.filter((s) => s.sourceId !== "codex");
  const { queryByText } = render(
    <ModelChooser sources={configured} catalogBySource={CATALOG} onSelectModel={noop} />,
  );
  assert.equal(queryByText("Configured only"), null, "no toggle when every source is configured");
});

test("a host device-code sign-in shows only on its own source's detail (D-065 M5)", () => {
  const deviceCode = { verificationUrl: "https://auth.example/device", userCode: "WXYZ-9999" };
  const { getByLabelText, getByText, queryByText, rerender } = render(
    <ModelChooser
      sources={SOURCES}
      catalogBySource={CATALOG}
      onSelectModel={noop}
      deviceCode={deviceCode}
      deviceCodeSourceId="codex"
    />,
  );
  // The flow belongs to codex: opening it shows the device code in its auth panel.
  fireEvent.click(getByLabelText("Open OpenAI (Codex)"));
  assert.ok(getByText("WXYZ-9999"), "the user code shows on the flow's own source");

  // Re-point the flow at another source: codex's detail no longer shows the code (gated by sourceId).
  rerender(
    <ModelChooser
      sources={SOURCES}
      catalogBySource={CATALOG}
      onSelectModel={noop}
      deviceCode={deviceCode}
      deviceCodeSourceId="anthropic-api"
    />,
  );
  assert.equal(queryByText("WXYZ-9999"), null, "the device code is gated to its own source");
});

test("loading shows a skeleton; empty shows a configure-a-source message", () => {
  const loading = render(
    <ModelChooser sources={[]} catalogBySource={{}} loading onSelectModel={noop} />,
  );
  assert.ok(loading.getByLabelText("Loading sources"), "a loading skeleton renders");

  const empty = render(<ModelChooser sources={[]} catalogBySource={{}} onSelectModel={noop} />);
  assert.ok(
    (empty.container.textContent ?? "").includes("has not reported any model sources"),
    "the empty state explains the host has not reported sources",
  );
});

test("the pin star toggles a model and the Pinned filter narrows to pinned models", () => {
  const pins: ModelRef[] = [];
  const pinnedKeys = new Set([modelRefKey({ sourceId: "lmstudio", modelId: "qwen3-30b" })]);
  const { getByLabelText, getByRole, queryByText } = render(
    <ModelChooser
      sources={SOURCES}
      catalogBySource={CATALOG}
      onSelectModel={noop}
      pinnedKeys={pinnedKeys}
      recentKeys={new Set()}
      onTogglePin={(ref) => pins.push(ref)}
    />,
  );
  fireEvent.click(getByLabelText("Open LM Studio"));
  // Qwen3 30B is pinned -> its star is the "Unpin" affordance; clicking it emits the stable ref.
  fireEvent.click(getByLabelText("Unpin Qwen3 30B"));
  assert.deepEqual(pins, [{ sourceId: "lmstudio", modelId: "qwen3-30b", reasoning: null }]);
  // An unpinned model offers the "Pin" affordance.
  assert.ok(getByLabelText("Pin Llama 3.3"), "an unpinned model shows a Pin star");
  // The Pinned chip narrows to only the pinned model.
  fireEvent.click(getByRole("button", { name: "pinned" }));
  assert.ok(getByLabelText("Unpin Qwen3 30B"), "the pinned model stays under the Pinned filter");
  assert.equal(queryByText("Llama 3.3"), null, "unpinned models drop out under the Pinned filter");
});

test("the Recent filter narrows to recently-used models", () => {
  const recentKeys = new Set([modelRefKey({ sourceId: "lmstudio", modelId: "llama-3.3" })]);
  const { getByLabelText, getByRole, getByText, queryByText } = render(
    <ModelChooser
      sources={SOURCES}
      catalogBySource={CATALOG}
      onSelectModel={noop}
      recentKeys={recentKeys}
    />,
  );
  fireEvent.click(getByLabelText("Open LM Studio"));
  fireEvent.click(getByRole("button", { name: "recent" }));
  assert.ok(getByText("Llama 3.3"), "the recently-used model stays");
  assert.equal(queryByText("Qwen3 30B"), null, "models not in the recent set drop out");
});

test("without preference data, no pin stars or recent/pinned chips appear", () => {
  const { getByLabelText, queryByRole } = render(
    <ModelChooser sources={SOURCES} catalogBySource={CATALOG} onSelectModel={noop} />,
  );
  fireEvent.click(getByLabelText("Open LM Studio"));
  assert.equal(
    queryByRole("button", { name: "recent" }),
    null,
    "no Recent chip without recent data",
  );
  assert.equal(
    queryByRole("button", { name: "pinned" }),
    null,
    "no Pinned chip without a pin handler",
  );
  assert.equal(
    queryByRole("button", { name: "Pin Qwen3 30B" }),
    null,
    "no pin star without a pin handler",
  );
});

test("the default glyph marks the default model row and its source (plan 51 D-002/D-003)", () => {
  const defaultKey = modelRefKey({ sourceId: "lmstudio", modelId: "qwen3-30b" });
  const { getByLabelText, getByRole } = render(
    <ModelChooser
      sources={SOURCES}
      catalogBySource={CATALOG}
      onSelectModel={noop}
      defaultKey={defaultKey}
      pinnedKeys={new Set()}
      onTogglePin={noop}
      onSetDefault={noop}
    />,
  );
  // Source overview: LM Studio holds the default, so its row carries the default glyph.
  const lmRow = getByLabelText("Open LM Studio");
  assert.ok(
    within(lmRow).getByLabelText("Holds the default model"),
    "the source shows the default glyph",
  );
  const codexRow = getByLabelText("Open OpenAI (Codex)");
  assert.equal(
    within(codexRow).queryByLabelText("Holds the default model"),
    null,
    "a non-default source has no glyph",
  );
  // Model detail: the default row carries the BadgeCheck default glyph.
  fireEvent.click(getByRole("button", { name: "Open LM Studio" }));
  assert.ok(
    getByLabelText("Qwen3 30B is the default"),
    "the default model row shows the default glyph",
  );
});

test("a default+pinned+selected model shows all three glyphs at once (no overlap)", () => {
  const ref = { sourceId: "lmstudio", modelId: "qwen3-30b" };
  const key = modelRefKey(ref);
  const { getByLabelText, getByText } = render(
    <ModelChooser
      sources={SOURCES}
      catalogBySource={CATALOG}
      initialSourceId="lmstudio"
      activeModel={{ ...ref, reasoning: null }}
      defaultKey={key}
      pinnedKeys={new Set([key])}
      onTogglePin={noop}
      onSetDefault={noop}
      onSelectModel={noop}
    />,
  );
  // Default (BadgeCheck), selected (the select button is pressed), pinned (the Unpin star) all present.
  assert.ok(getByLabelText("Qwen3 30B is the default"), "default glyph");
  assert.equal(getByLabelText("Select Qwen3 30B").getAttribute("aria-pressed"), "true", "selected");
  assert.ok(getByLabelText("Unpin Qwen3 30B"), "pinned star");
  // It appears once, in the default slot (sorted to the top of the list).
  assert.ok(getByText("Qwen3 30B"));
});

test("right-clicking a model row opens the menu; Set as default / favorites call the handlers (D-002)", () => {
  const defaults: ModelRef[] = [];
  const favorites: ModelRef[] = [];
  const { getByLabelText, getByRole } = render(
    <ModelChooser
      sources={SOURCES}
      catalogBySource={CATALOG}
      initialSourceId="lmstudio"
      pinnedKeys={new Set()}
      onSetDefault={(ref) => defaults.push(ref)}
      onTogglePin={(ref) => favorites.push(ref)}
      onSelectModel={noop}
    />,
  );
  // The menu attaches to the row WRAPPER (the select button's parent), not the nested buttons.
  const wrapper = getByLabelText("Select Qwen3 30B").parentElement;
  assert.ok(wrapper, "the row wrapper exists");
  fireEvent.contextMenu(wrapper as Element);

  // "Set as default" routes to onSetDefault with the row's stable ref.
  fireEvent.click(getByRole("menuitem", { name: "Set as default" }));
  assert.deepEqual(defaults, [{ sourceId: "lmstudio", modelId: "qwen3-30b", reasoning: null }]);

  // Re-open and add to favorites (the model is not pinned, so the item reads "Add to favorites").
  fireEvent.contextMenu(wrapper as Element);
  fireEvent.click(getByRole("menuitem", { name: "Add to favorites" }));
  assert.deepEqual(favorites, [{ sourceId: "lmstudio", modelId: "qwen3-30b", reasoning: null }]);
});

test("the favorites menu item reads Remove when the row is already pinned (D-002)", () => {
  const key = modelRefKey({ sourceId: "lmstudio", modelId: "qwen3-30b" });
  const { getByLabelText, getByRole, queryByRole } = render(
    <ModelChooser
      sources={SOURCES}
      catalogBySource={CATALOG}
      initialSourceId="lmstudio"
      pinnedKeys={new Set([key])}
      onSetDefault={noop}
      onTogglePin={noop}
      onSelectModel={noop}
    />,
  );
  fireEvent.contextMenu(getByLabelText("Select Qwen3 30B").parentElement as Element);
  assert.ok(getByRole("menuitem", { name: "Remove from favorites" }), "a pinned row offers Remove");
  assert.equal(queryByRole("menuitem", { name: "Add to favorites" }), null);
});

test("a needs-auth source shows the auth panel (sign-in) instead of a model list", () => {
  const { getByLabelText, getByRole } = render(
    <ModelChooser sources={SOURCES} catalogBySource={{}} onSelectModel={noop} />,
  );
  fireEvent.click(getByLabelText("Open OpenAI (Codex)"));
  // The detail renders the no-secret auth panel with a host-owned sign-in action.
  assert.ok(
    getByRole("region", { name: "Source authentication" }),
    "the auth panel renders for a needs-auth source",
  );
  assert.ok(getByRole("button", { name: "Re-authenticate" }), "with its host-owned action");
});
