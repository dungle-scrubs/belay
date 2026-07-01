import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { test } from "vitest";
import { executeTool } from "../index";
import { deflatedZip, storedZip, tinyPng } from "./test-zip";
import { buildArchiveReadTool, runArchiveRead, runArchiveUnpack } from "./tool";

test("archive_read inspects local zip paths without using fetch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trevor-archive-read-"));
  try {
    const archivePath = join(dir, "evidence.zip");
    await writeFile(archivePath, storedZip([{ name: "logs/app.txt", content: "local hello" }]));
    const result = await runArchiveRead(
      { path: archivePath },
      {
        fetch: async () => {
          throw new Error("fetch should not run for local path reads");
        },
        resolveHost: async () => ["93.184.216.34"],
      },
    );

    assert.equal(result.path, archivePath);
    assert.equal(result.entries[0]?.path, "logs/app.txt");
    assert.equal(result.entries[0]?.processor, "text");
    assert.equal(result.entries[0]?.preview, "local hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("archive_read supports remote public URL reads and rejects private URL resolution", async () => {
  const archive = storedZip([{ name: "readme.md", content: "# remote" }]);
  const ok = await runArchiveRead(
    { url: "https://example.com/archive.zip" },
    {
      fetch: async () =>
        new Response(new Uint8Array(archive), {
          status: 200,
          headers: { "content-length": String(archive.byteLength) },
        }),
      resolveHost: async () => ["93.184.216.34"],
    },
  );
  assert.equal(ok.url, "https://example.com/archive.zip");
  assert.equal(ok.entries[0]?.preview, "# remote");

  await assert.rejects(
    () =>
      runArchiveRead(
        { url: "https://example.internal/archive.zip" },
        {
          fetch: async () => new Response(new Uint8Array(archive)),
          resolveHost: async () => ["10.1.2.3"],
        },
      ),
    /ARCHIVE_URL_REJECTED/u,
  );
});

test("archive_read returns deflated entries, image metadata, and preview-budget warnings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trevor-archive-processors-"));
  try {
    const archivePath = join(dir, "mixed.zip");
    await writeFile(
      archivePath,
      storedZip([
        { name: "image.png", content: tinyPng(320, 240) },
        ...Array.from({ length: 18 }, (_, index) => ({
          name: `big-${index}.txt`,
          content: String(index).repeat(70_000),
        })),
      ]),
    );

    const result = await runArchiveRead({ path: archivePath });
    const image = result.entries.find((entry) => entry.path === "image.png");
    assert.equal(image?.processor, "image");
    assert.equal(image?.width, 320);
    assert.match(image?.contentHash ?? "", /^[0-9a-f]{64}$/u);
    assert.ok(result.warnings.some((warning) => warning.includes("preview budget")));

    const deflatedPath = join(dir, "deflated.zip");
    await writeFile(
      deflatedPath,
      deflatedZip({ name: "src/index.ts", content: "export const x = 1;" }),
    );
    const deflated = await runArchiveRead({ path: deflatedPath });
    assert.equal(deflated.entries[0]?.preview, "export const x = 1;");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("archive_unpack extracts selected entries into an explicit destination and rejects unsafe entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trevor-archive-unpack-"));
  try {
    const archivePath = join(dir, "evidence.zip");
    const destination = join(dir, "out");
    await writeFile(
      archivePath,
      storedZip([
        { name: "logs/app.txt", content: "local hello" },
        { name: "src/index.ts", content: "export const value = 1;\n" },
      ]),
    );

    const result = await runArchiveUnpack({
      path: archivePath,
      destination,
      include: ["logs/**"],
    });

    assert.equal(result.destination, destination);
    assert.deepEqual(
      result.extractedEntries.map((entry) => entry.path),
      ["logs/app.txt"],
    );
    assert.equal(await readFile(join(destination, "logs/app.txt"), "utf8"), "local hello");

    const unsafePath = join(dir, "unsafe.zip");
    await writeFile(unsafePath, storedZip([{ name: "../escape.txt", content: "nope" }]));
    await assert.rejects(
      () => runArchiveUnpack({ path: unsafePath, destination }),
      /ARCHIVE_ENTRY_UNSAFE/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registered archive tools expose typed failure lines and readOnly metadata", async () => {
  const tool = buildArchiveReadTool();
  assert.equal(tool.readOnly, true);

  const output = await Effect.runPromise(
    executeTool("archive_read", JSON.stringify({ path: "/definitely/missing.zip" }), "r1", "c1"),
  );
  assert.match(output, /^error: archive_read failed -/u);
});
