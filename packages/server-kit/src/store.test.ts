import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, test } from "vitest";
import { json } from "./http";
import { startStore } from "./store";

const originalPort = process.env.TEST_STORE_PORT;
const originalHost = process.env.TEST_STORE_HOST;

afterEach(() => {
  restoreEnv("TEST_STORE_PORT", originalPort);
  restoreEnv("TEST_STORE_HOST", originalHost);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test("startStore reads the env port/host convention and prints the standard banner", async () => {
  process.env.TEST_STORE_PORT = "0";
  delete process.env.TEST_STORE_HOST;
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line?: unknown) => {
    lines.push(String(line));
  };
  try {
    const running = await startStore({
      name: "test-store",
      envPrefix: "TEST_STORE",
      reservedPort: 65535,
      dataLabel: "root",
      dataPath: "/tmp/trevor-test-store",
      build: () => createServer((_req, res) => json(res, 200, { ok: true })),
    });
    try {
      assert.ok(running.port > 0);
      assert.equal(running.url, `http://127.0.0.1:${running.port}`);
      assert.match(lines.at(-1) ?? "", /\[test-store\] listening on http:\/\/127\.0\.0\.1:/);
      assert.match(lines.at(-1) ?? "", /\(root: \/tmp\/trevor-test-store\)/);
    } finally {
      await running.close();
    }
  } finally {
    console.log = originalLog;
  }
});
