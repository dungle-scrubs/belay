import assert from "node:assert/strict";
import { test } from "vitest";

// Covers the facade's not-yet-loaded window (Tier 5.2), so the hljs engine must start UNLOADED: the
// facade is imported dynamically inside the tests (a static import could race other suites only if
// registries were shared; vitest isolates per file, and the dynamic import keeps the intent explicit)
// and nothing here calls preloadHighlightEngine before asserting the plain-path behavior.

test("a fence that can never highlight does not trigger the engine load", async () => {
  const facade = await import("./code-highlight");
  assert.equal(facade.isHighlightEngineReady(), false);

  assert.equal(facade.highlightCode("", "plain text\n").highlighted, false);
  assert.equal(facade.highlightCode("mermaid", "graph TD\n  A-->B\n").highlighted, false);
  assert.equal(facade.resolveHighlightLanguage(""), null);
  assert.equal(facade.resolveHighlightLanguage("MERMAID"), null);

  // Give a (wrongly) kicked-off in-process dynamic import ample time to settle before checking.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(facade.isHighlightEngineReady(), false);
});

test("the first plausible request renders plain, triggers the load, and notifies once ready", async () => {
  const facade = await import("./code-highlight");
  assert.equal(facade.isHighlightEngineReady(), false);

  let notified = 0;
  const unsubscribe = facade.subscribeHighlightEngine(() => {
    notified += 1;
  });

  // Engine still in flight: the block stays plain (the caller renders <pre><code> as usual).
  assert.equal(facade.highlightCode("ts", "const answer = 42;\n").highlighted, false);
  assert.equal(facade.resolveHighlightLanguage("ts"), null);

  // preload joins the already-triggered load rather than starting a second one.
  await facade.preloadHighlightEngine();
  assert.equal(facade.isHighlightEngineReady(), true);
  assert.equal(notified, 1);

  // The same call now highlights - a re-render after the ready notification succeeds.
  const result = facade.highlightCode("ts", "const answer = 42;\n");
  assert.ok(result.highlighted && result.html.includes('<span class="hljs-keyword">const</span>'));
  assert.equal(facade.resolveHighlightLanguage("ts"), "ts");

  unsubscribe();
});
