import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCommandRegistry } from "@host/commands/commands";
import { ToolExecutionError, ToolInputError } from "@host/tools/errors";
import { MAX_OUTPUT } from "@host/tools/shared";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../src/mcp/config";
import { createMcpRuntime, type McpRuntime } from "../../src/mcp/runtime";
import { httpFixtureConfig, stdioFixtureConfig } from "./fixture-config";
import { startFixtureHttpServer } from "./fixture-http-server";

/**
 * MCP prompt import integration (plan 23 M6): prompts/list + prompts/get against the REAL
 * fixture servers become imported prompt ARTIFACTS - provenance-carrying records with
 * server-side argument substitution and bounded expansion - and are explicitly NOT Trevor
 * slash commands.
 */

async function withRuntime(
  servers: readonly McpServerConfig[],
  run: (runtime: McpRuntime) => Promise<void>,
): Promise<void> {
  const runtime = createMcpRuntime(servers);
  try {
    await run(runtime);
  } finally {
    await runtime.close();
  }
}

describe("mcp prompts - imported artifacts", () => {
  it("lists prompts with provenance and qualified identity", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      const prompts = await Effect.runPromise(runtime.listPrompts("alpha"));
      expect(prompts).toMatchObject([
        {
          kind: "prompt",
          server: "alpha",
          qualifiedName: "alpha:summarize",
          description: "summarize the given text",
        },
        { qualifiedName: "alpha:greet" },
      ]);
    });
  });

  it("gets a prompt with arguments substituted server-side (MCP spec) into an artifact", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      const artifact = await Effect.runPromise(
        runtime.getPrompt("alpha:summarize", { text: "the quick brown fox" }),
      );
      expect(artifact).toMatchObject({
        kind: "mcp_prompt",
        server: "alpha",
        name: "summarize",
        qualifiedName: "alpha:summarize",
        truncated: false,
      });
      expect(artifact.messages[0]?.role).toBe("user");
      expect(artifact.messages[0]?.text).toContain("the quick brown fox");
    });
  });

  it("gets an argument-less prompt", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      const artifact = await Effect.runPromise(runtime.getPrompt("alpha:greet"));
      expect(artifact.messages).toEqual([{ role: "user", text: "Hello from the fixture prompt!" }]);
    });
  });

  it("bounds an oversized prompt expansion and flags the truncation", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      const artifact = await Effect.runPromise(
        runtime.getPrompt("alpha:summarize", { text: "x".repeat(MAX_OUTPUT * 3) }),
      );
      expect(artifact.truncated).toBe(true);
      const total = artifact.messages.reduce((sum, message) => sum + message.text.length, 0);
      expect(total).toBeLessThanOrEqual(MAX_OUTPUT + "\n…[truncated]".length);
    });
  });

  it("bounds an oversized prompt DESCRIPTION - no unbounded server string reaches the model", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      const artifact = await Effect.runPromise(runtime.getPrompt("alpha:verbose"));
      expect(artifact.truncated).toBe(true);
      expect(artifact.description?.length).toBeLessThanOrEqual(
        MAX_OUTPUT + "\n…[truncated]".length,
      );
      expect(artifact.description?.endsWith("…[truncated]")).toBe(true);
    });
  });

  it("imports prompts over http too", async () => {
    const fixture = await startFixtureHttpServer();
    try {
      await withRuntime([httpFixtureConfig("beta", fixture.endpoint)], async (runtime) => {
        const artifact = await Effect.runPromise(
          runtime.getPrompt("beta:summarize", { text: "http substitution" }),
        );
        expect(artifact.server).toBe("beta");
        expect(artifact.messages[0]?.text).toContain("http substitution");
      });
    } finally {
      await fixture.close();
    }
  });

  it("fails an unknown prompt as a typed execution error", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      const error = await Effect.runPromise(Effect.flip(runtime.getPrompt("alpha:no_such")));
      expect(error).toBeInstanceOf(ToolExecutionError);
    });
  });

  it("rejects prompts on a server that does not expose them (D-002)", async () => {
    await withRuntime(
      [stdioFixtureConfig("alpha", { exposure: { tools: true, resources: true, prompts: false } })],
      async (runtime) => {
        const error = await Effect.runPromise(Effect.flip(runtime.getPrompt("alpha:greet")));
        expect(error).toBeInstanceOf(ToolInputError);
        expect((error as ToolInputError).detail).toContain("does not expose prompts");
      },
    );
  });
});

describe("mcp prompts - NOT Trevor slash commands", () => {
  it("importing prompts registers nothing in the host slash-command registry", async () => {
    await withRuntime([stdioFixtureConfig("alpha")], async (runtime) => {
      await Effect.runPromise(runtime.getPrompt("alpha:summarize", { text: "hi" }));
      const names = buildCommandRegistry().specs.map((spec) => spec.name);
      expect(names).not.toContain("/summarize");
      expect(names).not.toContain("/greet");
      expect(names).not.toContain("/alpha:summarize");
    });
  });

  it("the mcp runtime source never touches the command registry (structural guard)", () => {
    const mcpDir = join(import.meta.dirname, "..", "..", "src", "mcp");
    for (const file of readdirSync(mcpDir).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(join(mcpDir, file), "utf8");
      expect(source, `${file} must not import the command registry`).not.toMatch(
        /@host\/commands|buildCommandRegistry|CommandSpec/,
      );
    }
  });
});
