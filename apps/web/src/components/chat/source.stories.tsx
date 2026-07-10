import type { Meta, StoryObj } from "@storybook/react-vite";
import { storyFrame } from "@/components/chat/story-frame";
import { DocsResult, type ParsedDocs } from "./docs";
import { SourceFavicon, SourceUrl } from "./source";
import { WebFetchResult } from "./web-fetch";
import { type WebSearchResultItem, WebSearchResults } from "./web-search";

/**
 * Source-card favicon (plan 58.6.4 D7): the site favicon rendered beside the hostname on web_search,
 * web_fetch, and docs source rows - same-origin `/favicon.ico`, lazy + no-referrer, with a globe
 * fallback so a source row never shows a broken image. Includes a forced-broken row (an `.invalid`
 * host whose favicon never loads) to show the fallback.
 */

const meta: Meta<typeof SourceUrl> = {
  title: "Chat/SourceFavicon",
  component: SourceUrl,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof SourceUrl>;

const Frame = storyFrame("w-[44rem]");

const SEARCH_RESULTS: WebSearchResultItem[] = [
  {
    title: "Node.js 22 enters Long Term Support",
    url: "https://nodejs.org/en/blog/release/v22.0.0",
    snippet: "Node.js 22 is now the Active LTS release line, recommended for most production use.",
    published: "2 days ago",
  },
  {
    title: "Releases - nodejs/node - GitHub",
    url: "https://github.com/nodejs/node/releases",
    snippet: "The changelog and downloadable artifacts for every Node.js release.",
  },
  {
    title: "MDN Web Docs - fetch()",
    url: "https://developer.mozilla.org/en-US/docs/Web/API/fetch",
    snippet: "The Fetch API provides an interface for fetching resources across the network.",
  },
];

const DOCS: ParsedDocs = {
  action: "search",
  outcome: "ok",
  queryText: "effect schema decode",
  corpus: {
    subject: "Effect",
    rootUrl: "https://effect.website/docs",
    pageCount: 214,
    byteCount: 1_800_000,
  },
  excerpts: [
    {
      url: "https://effect.website/docs/schema/introduction",
      title: "Schema - Introduction",
      locator: "§ Overview",
      excerpt: "Schema is a library for defining and using schemas to validate and transform data.",
    },
    {
      url: "https://effect.website/docs/schema/transformations",
      title: "Schema Transformations",
      locator: "§ decode",
      excerpt: "decode runs a schema's decoding transformation, returning an Effect.",
    },
  ],
};

/** The favicon on its own, over a handful of real hosts plus one that will fall back to the globe. */
export const Favicons: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-col gap-3">
        <SourceUrl url="https://nodejs.org/en/blog" />
        <SourceUrl url="https://github.com/nodejs/node" />
        <SourceUrl url="https://developer.mozilla.org/en-US/docs/Web/API/fetch" />
        <SourceUrl url="https://this-host-does-not-exist.invalid/some/page" />
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <SourceFavicon url="/Users/me/notes.md" /> non-web source (globe, no request)
        </span>
      </div>
    </Frame>
  ),
};

export const WebSearchCard: Story = {
  render: () => (
    <Frame>
      <WebSearchResults query="node 22 lts" provider="brave" results={SEARCH_RESULTS} />
    </Frame>
  ),
};

export const WebFetchCard: Story = {
  render: () => (
    <Frame>
      <WebFetchResult
        url="https://nodejs.org/en/blog/release/v22.0.0"
        parsed={{
          url: "https://nodejs.org/en/blog/release/v22.0.0",
          finalUrl: "https://nodejs.org/en/blog/release/v22.0.0",
          title: "Node.js 22 enters Long Term Support",
          backend: "static",
          content: "Node.js 22 is now the Active LTS release line.\n\nUpgrade at your convenience.",
        }}
      />
    </Frame>
  ),
};

export const DocsCard: Story = {
  render: () => (
    <Frame>
      <DocsResult args="search effect schema decode" parsed={DOCS} />
    </Frame>
  ),
};

/** A source row whose favicon host resolves nowhere, so the img errors and the globe placeholder wins. */
export const ForcedBrokenFallback: Story = {
  render: () => (
    <Frame>
      <SourceUrl url="https://this-host-does-not-exist.invalid/some/page" />
    </Frame>
  ),
};
