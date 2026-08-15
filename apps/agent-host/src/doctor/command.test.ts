import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { afterEach, beforeEach, test } from "vitest";
import type { ProviderRegistry } from "../providers";
import { buildDoctorCommandResult, type DoctorCommandInput } from "./build";

/**
 * D-073 M1 / D-020: `/doctor` command-variant parsing is private to the doctor builder. These tests
 * pin the public command result behavior: default structured JSON, text/plain aliases, lenient
 * unknown tokens, case-insensitivity, and last-view-wins where the selected view changes the output
 * shape.
 */

let stateHome: string;
const savedStateHome = process.env.BELAY_STATE_HOME;

beforeEach(() => {
  stateHome = mkdtempSync(join(tmpdir(), "belay-doctor-command-"));
  process.env.BELAY_STATE_HOME = stateHome;
});

afterEach(() => {
  if (savedStateHome === undefined) {
    delete process.env.BELAY_STATE_HOME;
  } else {
    process.env.BELAY_STATE_HOME = savedStateHome;
  }
  rmSync(stateHome, { recursive: true, force: true });
});

const providers = {
  qwen: {
    id: "qwen",
    label: "Qwen",
    model: "qwen3",
    reasoningLevels: [],
    defaultReasoning: "off",
    kind: "local",
    describe: () => ({
      label: "Qwen",
      model: "qwen3",
      reasoningLevels: [],
      defaultReasoning: "off",
      kind: "local",
    }),
    readiness: () => Effect.succeed({ ready: true, warm: true }),
    capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 8192 }),
    warm: () => Effect.void,
    stream: () => Stream.empty,
  },
} as unknown as ProviderRegistry;

function facts(): DoctorCommandInput {
  return {
    providers,
    cwd: "/repo",
    workspace: "/repo",
    instanceId: "host-1",
    role: "leader",
    host: { queued: 0, lastTurn: "answered" },
  };
}

function isJson(text: string): boolean {
  JSON.parse(text);
  return true;
}

test("no args returns the default structured snapshot JSON", async () => {
  const result = await buildDoctorCommandResult("", facts());
  assert.equal(isJson(result), true);
  assert.equal(JSON.parse(result).host.instanceId, "host-1");
});

test("text view aliases return the legacy plaintext report", async () => {
  const text = await buildDoctorCommandResult("text", facts());
  assert.match(text, /^workspace: \/repo/u);
  assert.match(text, /qwen - Qwen \(qwen3\) - warm/u);

  const plain = await buildDoctorCommandResult("plain", facts());
  assert.equal(plain, text);
});

test("tokens are case-insensitive, unknown tokens are ignored, and the last view wins", async () => {
  assert.match(await buildDoctorCommandResult("PLAIN wat", facts()), /^workspace: \/repo/u);
  assert.equal(isJson(await buildDoctorCommandResult("wat", facts())), true);
  assert.equal(isJson(await buildDoctorCommandResult("text json", facts())), true);
  assert.match(await buildDoctorCommandResult("json text", facts()), /^workspace: \/repo/u);
});

test("refresh and copy flags combine with structured views without changing the result shape", async () => {
  assert.equal(isJson(await buildDoctorCommandResult("full refresh copy", facts())), true);
  assert.equal(isJson(await buildDoctorCommandResult("json copy", facts())), true);
});

test("the structured snapshot renders the injected MCP rollup in the MCP area (plan 23 M8)", async () => {
  const detail = "2 servers (stdio+http) · 2 ready · 11 tools / 3 resources / 2 prompts";
  const result = await buildDoctorCommandResult("", {
    ...facts(),
    mcp: { kind: "ready", detail },
  });
  const areas = JSON.parse(result).areas as { id: string; status: string; verdict: string }[];
  const mcp = areas.find((area) => area.id === "mcp");
  assert.equal(mcp?.status, "ok");
  assert.equal(mcp?.verdict, detail);
});

test("without an injected MCP state the MCP area stays unconfigured (not an error)", async () => {
  const result = await buildDoctorCommandResult("", facts());
  const areas = JSON.parse(result).areas as { id: string; status: string; verdict: string }[];
  const mcp = areas.find((area) => area.id === "mcp");
  assert.equal(mcp?.status, "not_checked");
  assert.match(mcp?.verdict ?? "", /not configured/);
});
