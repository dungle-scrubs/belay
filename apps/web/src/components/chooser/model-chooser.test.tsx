import assert from "node:assert/strict";
import { fireEvent, render, within } from "@testing-library/react";
import { type CatalogEntry, type ModelRef, modelRefKey, type SourceSummary } from "@trevor/session";
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
  source({ sourceId: "anthropic", label: "Anthropic API", type: "api-key", modelCount: 4 }),
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
      deviceCodeSourceId="anthropic"
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
