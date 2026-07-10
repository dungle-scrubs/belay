import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import { test } from "vitest";
import { faviconUrl, prettyUrl, SourceFavicon, SourceUrl } from "./source";

/**
 * Source-card favicon (plan 58.6.4 D7). The favicon is same-origin `/favicon.ico` only (no
 * third-party aggregator), lazy + no-referrer, and falls back to a neutral globe the instant it
 * fails - never a broken-image icon. A non-web URL (a source-recall file path) derives no favicon
 * and renders the globe directly, unchanged.
 */

test("faviconUrl derives the same-origin /favicon.ico for http(s) URLs only", () => {
  assert.equal(faviconUrl("https://example.com/some/page"), "https://example.com/favicon.ico");
  assert.equal(faviconUrl("http://www.foo.org/x?y=1"), "http://www.foo.org/favicon.ico");
  assert.equal(faviconUrl("file:///Users/me/notes.md"), null, "a file path has no site icon");
  assert.equal(faviconUrl("not a url"), null, "an unparseable URL yields no favicon");
});

test("prettyUrl strips www and the bare root path", () => {
  assert.equal(prettyUrl("https://www.example.com/"), "example.com");
  assert.equal(prettyUrl("https://docs.rs/effect/latest"), "docs.rs/effect/latest");
});

test("SourceFavicon renders a lazy, no-referrer, same-origin favicon img", () => {
  const { container } = render(<SourceFavicon url="https://example.com/page" />);
  const img = container.querySelector("img");
  assert.ok(img, "renders an img before any error");
  assert.equal(img?.getAttribute("src"), "https://example.com/favicon.ico");
  assert.equal(img?.getAttribute("loading"), "lazy");
  assert.equal(img?.getAttribute("referrerpolicy"), "no-referrer");
});

test("a failing favicon falls back to the globe placeholder, not a broken image", () => {
  const { container } = render(<SourceFavicon url="https://example.com/page" />);
  const img = container.querySelector("img");
  assert.ok(img, "starts as an img");
  fireEvent.error(img as Element);
  assert.equal(container.querySelector("img"), null, "the broken img is gone");
  assert.ok(container.querySelector("svg"), "the globe placeholder is shown instead");
});

test("a non-web URL (source-recall-style path) renders the globe directly, no img request", () => {
  const { container } = render(<SourceFavicon url="/Users/me/notes.md" />);
  assert.equal(container.querySelector("img"), null, "no favicon request for a file path");
  assert.ok(container.querySelector("svg"), "the globe placeholder renders");
});

test("SourceUrl shows the favicon beside the pretty hostname", () => {
  const { container } = render(<SourceUrl url="https://www.example.com/docs/intro" />);
  assert.ok(container.querySelector("img"), "the favicon renders in the hostname line");
  assert.ok(
    (container.textContent ?? "").includes("example.com/docs/intro"),
    "shows the pretty url",
  );
});
