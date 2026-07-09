import assert from "node:assert/strict";
import type { CatalogSnapshot, TrevorClient } from "@trevor/sdk";
import type { ArtifactRef, SessionSummary } from "@trevor/session";
import { test } from "vitest";
import {
  COMMAND_SPECS,
  type CommandRouterDeps,
  commandUsageText,
  createCommandRouter,
  flagValue,
  inferMime,
  positionals,
} from "./command-router";

const REF: ArtifactRef = {
  kind: "file",
  mimeType: "text/markdown",
  size: 4,
  hash: "a".repeat(64),
};

const CATALOG: CatalogSnapshot = {
  sources: [],
  catalogBySource: {
    openai: [
      {
        sourceId: "openai",
        modelId: "gpt-5",
        displayName: "GPT-5",
        kind: "cloud",
        capabilities: ["reasoning"],
        contextLength: null,
        costTier: null,
        aliases: [],
        freshness: { refreshedAt: null, stale: false },
        reasoningLevels: ["off", "low", "high"],
        defaultReasoning: "low",
      },
    ],
  },
};

function makeDeps(overrides: Partial<CommandRouterDeps> = {}): CommandRouterDeps {
  const uploads: Array<{
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly name: string | undefined;
  }> = [];
  const downloads: string[] = [];
  const writtenFiles: Array<{ readonly path: string; readonly bytes: Uint8Array }> = [];
  const stdoutBytes: Uint8Array[] = [];
  const sessions: readonly SessionSummary[] = [];
  const client = {
    listCatalog: async () => CATALOG,
    uploadArtifact: async (
      bytes: Uint8Array,
      mimeType: string,
      options?: { readonly name?: string },
    ) => {
      uploads.push({ bytes, mimeType, name: options?.name });
      return { ...REF, mimeType, size: bytes.byteLength, name: options?.name };
    },
    downloadArtifact: async (hash: string) => {
      downloads.push(hash);
      return new Uint8Array([9, 8, 7]);
    },
  } as unknown as TrevorClient;

  return {
    client,
    lifecycleIo: {
      fetchSessions: async () => sessions,
      publishArchived: async () => {},
      now: () => 0,
    },
    hostControlIo: {
      lookupHost: () => null,
      processAlive: () => false,
      signal: () => {},
      removeHost: () => {},
    },
    projectName: () => "trevor",
    ensureHostOnline: async () => ({ sessionId: "s1" }),
    readFile: () => new Uint8Array([1, 2, 3, 4]),
    writeFile: (path, bytes) => {
      writtenFiles.push({ path, bytes });
    },
    writeStdoutBytes: (bytes) => {
      stdoutBytes.push(bytes);
    },
    ...overrides,
  };
}

test("flag parsing keeps values out of positionals", () => {
  const args = ["s1", "--provider", "qwen", "hello", "--json", "--timeout", "1000"];

  assert.equal(flagValue(args, "--provider"), "qwen");
  assert.deepEqual(positionals(args, ["--provider", "--timeout"]), ["s1", "hello"]);
});

test("infers artifact MIME types from explicit flag or file extension", () => {
  assert.equal(inferMime("note.md"), "text/markdown");
  assert.equal(inferMime("photo.jpeg"), "image/jpeg");
  assert.equal(inferMime("archive.bin", "application/x-test"), "application/x-test");
  assert.equal(inferMime("archive.bin"), "application/octet-stream");
});

test("usage output is generated from every registered command", () => {
  const usage = commandUsageText();

  for (const spec of COMMAND_SPECS) {
    assert.ok(usage.includes(spec.usage), `missing usage for ${spec.name}`);
  }
});

test("router returns null for no subcommand and usage for invalid command branches", async () => {
  const router = createCommandRouter(makeDeps());

  assert.equal(await router.runSubcommand([]), null);
  assert.equal(await router.runSubcommand(["not-real"]), null);
  assert.equal(
    await router.runSubcommand(["prompt", "s1"]),
    "usage: trevor prompt <session> <text> [--model source/model] [--reasoning level] [--json] [--timeout ms]",
  );
  assert.equal(
    await router.runSubcommand(["artifact"]),
    "usage: trevor artifact put <file> | trevor artifact get <hash> [outfile]",
  );
});

test("router dispatches lifecycle commands through injected lifecycle IO", async () => {
  let archived: { readonly sessionId: string; readonly archived: boolean } | undefined;
  const router = createCommandRouter(
    makeDeps({
      lifecycleIo: {
        fetchSessions: async () => [],
        publishArchived: async (sessionId, value) => {
          archived = { sessionId, archived: value };
        },
        now: () => 0,
      },
    }),
  );

  assert.equal(await router.runSubcommand(["list"]), "Sessions for trevor:\nNo sessions.");
  assert.ok((await router.runSubcommand(["archive", "s1"]))?.includes("Archived"));
  assert.deepEqual(archived, { sessionId: "s1", archived: true });
});

test("router handles artifact put/get with injected file and byte IO", async () => {
  const writes: Array<{ readonly path: string; readonly bytes: Uint8Array }> = [];
  const stdout: Uint8Array[] = [];
  const router = createCommandRouter(
    makeDeps({
      writeFile: (path, bytes) => writes.push({ path, bytes }),
      writeStdoutBytes: (bytes) => stdout.push(bytes),
    }),
  );

  const put = await router.runSubcommand(["artifact", "put", "note.md", "--json"]);
  assert.equal(JSON.parse(put ?? "{}").mimeType, "text/markdown");

  assert.equal(
    await router.runSubcommand(["artifact", "get", "a".repeat(64), "out.bin"]),
    "Wrote 3 bytes to out.bin.",
  );
  assert.deepEqual(writes, [{ path: "out.bin", bytes: new Uint8Array([9, 8, 7]) }]);

  assert.equal(await router.runSubcommand(["artifact", "get", "a".repeat(64)]), "");
  assert.deepEqual(stdout, [new Uint8Array([9, 8, 7])]);
});

test("router lists models after ensuring the host is online", async () => {
  let ensured = false;
  const router = createCommandRouter(
    makeDeps({
      ensureHostOnline: async () => {
        ensured = true;
        return { sessionId: "s1" };
      },
    }),
  );

  const output = await router.runSubcommand(["models"]);

  assert.equal(ensured, true);
  assert.match(output ?? "", /openai\/gpt-5/);
  assert.match(output ?? "", /reasoning: off, low, high/);
});

test("router maps model catalog read failures to a CLI stage", async () => {
  const router = createCommandRouter(
    makeDeps({
      client: {
        listCatalog: async () => {
          throw new Error("store offline");
        },
      } as unknown as TrevorClient,
    }),
  );

  await assert.rejects(() => router.runSubcommand(["models"]), {
    name: "CliStageError",
    stage: "catalog-read",
    message: "store offline",
  });
});
