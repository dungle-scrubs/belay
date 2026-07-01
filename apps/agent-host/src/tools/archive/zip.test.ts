import assert from "node:assert/strict";
import { test } from "vitest";
import { ArchiveToolError } from "./errors";
import { centralDirectoryZip, storedZip } from "./test-zip";
import { normalizeArchiveEntryName } from "./validators";
import { parseZipEntries } from "./zip";

test("normalizes safe archive entry names and rejects traversal or absolute paths", () => {
  assert.equal(normalizeArchiveEntryName("logs\\app.txt"), "logs/app.txt");

  for (const name of ["/etc/passwd", "../x", "a/../../x", "C:/Users/k/file.txt", "nested.zip"]) {
    assert.throws(() => normalizeArchiveEntryName(name), ArchiveToolError);
  }
});

test("parseZipEntries rejects duplicate normalized names and enforces entry and expanded limits", () => {
  const duplicate = storedZip([
    { name: "logs/app.txt", content: "one" },
    { name: "logs\\app.txt", content: "two" },
  ]);
  assert.throws(
    () => parseZipEntries(duplicate, { entryLimit: 10, maxExpandedBytes: 100 }),
    /duplicate entry path/u,
  );

  const twoEntries = storedZip([
    { name: "a.txt", content: "a" },
    { name: "b.txt", content: "b" },
  ]);
  assert.throws(
    () => parseZipEntries(twoEntries, { entryLimit: 1, maxExpandedBytes: 100 }),
    /entry limit/u,
  );
  assert.throws(
    () => parseZipEntries(twoEntries, { entryLimit: 10, maxExpandedBytes: 1 }),
    /expanded bytes/u,
  );
});

test("parseZipEntries applies include globs after safety validation", () => {
  const archive = storedZip([
    { name: "logs/app.txt", content: "hello" },
    { name: "src/index.ts", content: "export {};" },
  ]);
  const entries = parseZipEntries(archive, { entryLimit: 10, maxExpandedBytes: 100 }, ["logs/**"]);
  assert.deepEqual(
    entries.map((entry) => entry.normalizedPath),
    ["logs/app.txt"],
  );
});

test("parseZipEntries rejects encrypted entries and central-directory symlinks", () => {
  const encrypted = storedZip([{ name: "secret.txt", content: "secret" }]);
  new DataView(encrypted.buffer).setUint16(6, 1, true);
  assert.throws(
    () => parseZipEntries(encrypted, { entryLimit: 10, maxExpandedBytes: 100 }),
    /Encrypted zip entries/u,
  );

  const unixSymlinkMode = 0xa000 << 16;
  const symlink = centralDirectoryZip({
    name: "link",
    content: "target",
    externalAttributes: unixSymlinkMode,
  });
  assert.throws(
    () => parseZipEntries(symlink, { entryLimit: 10, maxExpandedBytes: 100 }),
    /symlink/u,
  );
});
