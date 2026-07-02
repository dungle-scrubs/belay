import { describe, expect, test } from "vitest";
import { discoverCapabilities, qualifyCapabilityName } from "./capabilities";
import type { McpExposure } from "./config";
import { McpRpcError, McpTimeoutError } from "./errors";
import type { McpTransport } from "./transport";

interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

/** A pure in-memory transport: serves canned list pages, records every request. */
function stubTransport(
  respond: (method: string, params: unknown) => unknown,
  calls: RecordedCall[] = [],
): McpTransport {
  return {
    initialize: () =>
      Promise.resolve({ protocolVersion: "2025-06-18", capabilities: { tools: {} } }),
    request: (method, params) => {
      calls.push({ method, params });
      return Promise.resolve(respond(method, params));
    },
    notify: () => {},
    close: () => Promise.resolve(),
    state: () => ({ status: "ready", initialized: true }),
  };
}

const ALL_EXPOSED: McpExposure = { tools: true, resources: true, prompts: true };

const CANNED = (method: string): unknown => {
  if (method === "tools/list") {
    return {
      tools: [
        {
          name: "echo",
          description: "echoes text back",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
        { name: "bare_tool" },
      ],
    };
  }
  if (method === "resources/list") {
    return {
      resources: [
        { uri: "fixture://readme", name: "readme", description: "docs", mimeType: "text/plain" },
      ],
    };
  }
  if (method === "prompts/list") {
    return {
      prompts: [{ name: "summarize", description: "sum it up", arguments: [{ name: "text" }] }],
    };
  }
  throw new Error(`unexpected method ${method}`);
};

describe("qualifyCapabilityName (D-005 qualified identity)", () => {
  test("joins server and simple name with a colon", () => {
    expect(qualifyCapabilityName("github", "search")).toBe("github:search");
  });
});

describe("discoverCapabilities", () => {
  test("maps tools, resources, and prompts to provenance-carrying qualified records", async () => {
    const discovered = await discoverCapabilities(
      { name: "alpha", exposure: ALL_EXPOSED },
      stubTransport(CANNED),
    );

    expect(discovered.server).toBe("alpha");
    expect(discovered.tools).toEqual([
      {
        kind: "tool",
        server: "alpha",
        name: "echo",
        qualifiedName: "alpha:echo",
        description: "echoes text back",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      },
      { kind: "tool", server: "alpha", name: "bare_tool", qualifiedName: "alpha:bare_tool" },
    ]);
    expect(discovered.resources).toEqual([
      {
        kind: "resource",
        server: "alpha",
        name: "readme",
        qualifiedName: "alpha:readme",
        uri: "fixture://readme",
        description: "docs",
        mimeType: "text/plain",
      },
    ]);
    expect(discovered.prompts).toEqual([
      {
        kind: "prompt",
        server: "alpha",
        name: "summarize",
        qualifiedName: "alpha:summarize",
        description: "sum it up",
        arguments: [{ name: "text" }],
      },
    ]);
  });

  test("never requests a family the exposure flags switch off (D-002)", async () => {
    const calls: RecordedCall[] = [];
    const discovered = await discoverCapabilities(
      { name: "alpha", exposure: { tools: true, resources: false, prompts: false } },
      stubTransport(CANNED, calls),
    );

    expect(discovered.tools.length).toBeGreaterThan(0);
    expect(discovered.resources).toEqual([]);
    expect(discovered.prompts).toEqual([]);
    expect(calls.map((call) => call.method)).toEqual(["tools/list"]);
  });

  test("drops entries without a usable name (tolerant decoding)", async () => {
    const discovered = await discoverCapabilities(
      { name: "alpha", exposure: ALL_EXPOSED },
      stubTransport((method) => {
        if (method === "tools/list") {
          return { tools: [{ description: "nameless" }, "not-an-object", { name: "kept" }] };
        }
        if (method === "resources/list") {
          return { resources: [{ name: "no_uri" }, { uri: "fixture://x", name: "kept" }] };
        }
        return { prompts: [{}, { name: "kept" }] };
      }),
    );

    expect(discovered.tools.map((tool) => tool.name)).toEqual(["kept"]);
    expect(discovered.resources.map((resource) => resource.name)).toEqual(["kept"]);
    expect(discovered.prompts.map((prompt) => prompt.name)).toEqual(["kept"]);
  });

  test("follows nextCursor pages until the list is complete", async () => {
    const calls: RecordedCall[] = [];
    const discovered = await discoverCapabilities(
      { name: "alpha", exposure: { tools: true, resources: false, prompts: false } },
      stubTransport((method, params) => {
        if (method !== "tools/list") {
          throw new Error(`unexpected ${method}`);
        }
        const cursor = (params as { cursor?: string } | undefined)?.cursor;
        if (cursor === undefined) {
          return { tools: [{ name: "page_one" }], nextCursor: "1" };
        }
        return { tools: [{ name: "page_two" }] };
      }, calls),
    );

    expect(discovered.tools.map((tool) => tool.name)).toEqual(["page_one", "page_two"]);
    expect(calls.map((call) => call.params)).toEqual([undefined, { cursor: "1" }]);
  });

  test("treats a method-not-found family as empty instead of failing discovery", async () => {
    const discovered = await discoverCapabilities(
      { name: "alpha", exposure: ALL_EXPOSED },
      stubTransport((method) => {
        if (method === "tools/list") {
          return { tools: [{ name: "echo" }] };
        }
        throw new McpRpcError({
          server: "alpha",
          method,
          code: -32601,
          detail: "method not found",
        });
      }),
    );

    expect(discovered.tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(discovered.resources).toEqual([]);
    expect(discovered.prompts).toEqual([]);
  });

  test("propagates hard transport failures untouched", async () => {
    await expect(
      discoverCapabilities(
        { name: "alpha", exposure: ALL_EXPOSED },
        stubTransport(() => {
          throw new McpTimeoutError({ server: "alpha", method: "tools/list", timeoutMs: 10 });
        }),
      ),
    ).rejects.toMatchObject({ _tag: "McpTimeoutError" });
  });
});
