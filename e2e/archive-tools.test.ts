import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, publishTurnVia, transportEmit } from "@trevor/agent-host/testing";
import type { RunningServer } from "@trevor/server-kit";
import { type SessionEvent, streamTransport } from "@trevor/session";
import { subscribe, waitFor } from "@trevor/test-kit";
import { bootStore } from "@trevor/test-kit/boot";
import { Stream } from "effect";
import { afterAll, beforeAll, test } from "vitest";

function storedZip(
  entries: ReadonlyArray<{ readonly name: string; readonly content: string }>,
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const content = encoder.encode(entry.content);
    const header = new Uint8Array(30 + name.byteLength);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, 0, true);
    view.setUint32(18, content.byteLength, true);
    view.setUint32(22, content.byteLength, true);
    view.setUint16(26, name.byteLength, true);
    header.set(name, 30);
    chunks.push(header, content);
  }
  const end = new Uint8Array(22);
  new DataView(end.buffer).setUint32(0, 0x06054b50, true);
  chunks.push(end);
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

let store: RunningServer;

beforeAll(async () => {
  store = await bootStore();
});

afterAll(async () => {
  await store.close();
});

test("archive_read runs through the hermetic model/tool/session loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trevor-e2e-archive-read-"));
  try {
    const archivePath = join(dir, "evidence.zip");
    await writeFile(
      archivePath,
      storedZip([{ name: "logs/app.txt", content: "archive evidence" }]),
    );

    const transport = streamTransport(store.url);
    await transport.ensureSession("archive-read");
    const viewer = subscribe(transport, "archive-read", "viewer");
    await waitFor(viewer.isReplayed);

    await publishTurnVia(
      transportEmit(transport, "archive-read", "host"),
      fakeProvider({
        stream: (messages) =>
          messages.some((message) => message.role === "tool")
            ? Stream.fromIterable([{ type: "text" as const, text: "I read the archive." }])
            : Stream.fromIterable([
                {
                  type: "tool_call" as const,
                  call: {
                    id: "archive-read-call",
                    name: "archive_read",
                    arguments: JSON.stringify({ path: archivePath }),
                  },
                },
              ]),
      }),
      [{ role: "user", content: "What is inside the local zip?" }],
      { runId: "archive-read-run" },
    );

    await waitFor(() => viewer.events.some((e) => e.type === "assistant.completed"), {
      label: "archive_read completed",
    });
    const completed = viewer.events.find((e: SessionEvent) => e.type === "tool.completed");
    assert.equal(completed?.payload.name, "archive_read");
    assert.ok(String(completed?.payload.result ?? "").includes("archive evidence"));
    viewer.connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("archive_unpack extracts selected entries through the hermetic model/tool/session loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trevor-e2e-archive-unpack-"));
  try {
    const archivePath = join(dir, "evidence.zip");
    const destination = join(dir, "out");
    await writeFile(
      archivePath,
      storedZip([
        { name: "logs/app.txt", content: "selected evidence" },
        { name: "src/index.ts", content: "export const x = 1;" },
      ]),
    );

    const transport = streamTransport(store.url);
    await transport.ensureSession("archive-unpack");
    const viewer = subscribe(transport, "archive-unpack", "viewer");
    await waitFor(viewer.isReplayed);

    await publishTurnVia(
      transportEmit(transport, "archive-unpack", "host"),
      fakeProvider({
        stream: (messages) =>
          messages.some((message) => message.role === "tool")
            ? Stream.fromIterable([
                { type: "text" as const, text: "I extracted the selected file." },
              ])
            : Stream.fromIterable([
                {
                  type: "tool_call" as const,
                  call: {
                    id: "archive-unpack-call",
                    name: "archive_unpack",
                    arguments: JSON.stringify({
                      path: archivePath,
                      destination,
                      include: ["logs/**"],
                    }),
                  },
                },
              ]),
      }),
      [{ role: "user", content: "Extract logs from the zip." }],
      { runId: "archive-unpack-run" },
    );

    await waitFor(() => viewer.events.some((e) => e.type === "assistant.completed"), {
      label: "archive_unpack completed",
    });
    const completed = viewer.events.find((e: SessionEvent) => e.type === "tool.completed");
    assert.equal(completed?.payload.name, "archive_unpack");
    assert.equal(await readFile(join(destination, "logs/app.txt"), "utf8"), "selected evidence");
    await assert.rejects(() => readFile(join(destination, "src/index.ts"), "utf8"));
    viewer.connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
