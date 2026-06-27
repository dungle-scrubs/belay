import assert from "node:assert/strict";
import { fireEvent, render, within } from "@testing-library/react";
import type { CatalogEntry, ModelRef, SourceSummary } from "@trevor/session";
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

test("loading shows a skeleton; empty shows a configure-a-source message", () => {
  const loading = render(
    <ModelChooser sources={[]} catalogBySource={{}} loading onSelectModel={noop} />,
  );
  assert.ok(loading.getByLabelText("Loading sources"), "a loading skeleton renders");

  const empty = render(<ModelChooser sources={[]} catalogBySource={{}} onSelectModel={noop} />);
  assert.ok(
    (empty.container.textContent ?? "").includes("No model sources are configured"),
    "the empty state explains there are no sources",
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
