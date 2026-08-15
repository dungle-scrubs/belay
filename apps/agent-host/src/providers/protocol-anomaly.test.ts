import assert from "node:assert/strict";
import { test } from "vitest";
import { classifyProviderProtocolAnomaly } from "./protocol-anomaly";

test("classifies provider-specific raw tool-call markup rendered as assistant text", () => {
  const diagnostic = classifyProviderProtocolAnomaly({
    providerId: "glm",
    text: '<tool_call>{"name":"read","arguments":{"path":"AGENTS.md"}}</tool_call>',
    toolCalls: [],
  });

  assert.equal(diagnostic?.phase, "model-step");
  assert.equal(diagnostic.retryable, true);
  assert.match(diagnostic.reason, /GLM/);
});

test("classifies DeepSeek full-width tool tags from rendered provider output", () => {
  const diagnostic = classifyProviderProtocolAnomaly({
    providerId: "deepseek",
    text: '<｜tool▁calls｜>[{"name":"bash","arguments":"{}"}]<｜/tool▁calls｜>',
    toolCalls: [],
  });

  assert.equal(diagnostic?.retryable, true);
  assert.match(diagnostic.reason, /DeepSeek/);
});

test("classifies DeepSeek DSML envelopes rendered as final text", () => {
  const diagnostic = classifyProviderProtocolAnomaly({
    providerId: "deepseek",
    text: [
      "< | | DSML | | tool_calls>",
      '< | | DSML | | invoke name="edit">',
      '< | | DSML | | parameter name="path" string="true">/Users/kevin/dev/app.ts< | | DSML | | parameter>',
      "</ | | DSML | | invoke>",
      "</ | | DSML | | tool_calls>",
    ].join("\n"),
    toolCalls: [],
  });

  assert.equal(diagnostic?.retryable, true);
  assert.match(diagnostic.reason, /DeepSeek/);
});

test("classifies a bare tool_calls JSON envelope leaked as text without tags", () => {
  const diagnostic = classifyProviderProtocolAnomaly({
    providerId: "deepseek",
    text: '{"tool_calls":[{"name":"bash","arguments":"echo hi"}]}',
    toolCalls: [],
  });

  assert.equal(diagnostic?.retryable, true);
  assert.match(diagnostic.reason, /DeepSeek/);
});

test("ignores normal assistant text and already parsed tool calls", () => {
  assert.equal(
    classifyProviderProtocolAnomaly({
      providerId: "minimax",
      text: "Here is the final answer.",
      toolCalls: [],
    }),
    null,
  );
  assert.equal(
    classifyProviderProtocolAnomaly({
      providerId: "minimax",
      text: '{"name":"read","arguments":{}}',
      toolCalls: [{ id: "c1", name: "read", arguments: "{}" }],
    }),
    null,
  );
});

test("ignores ordinary HTML, XML, and code snippets as prose, not protocol markup", () => {
  const prose = [
    '<div class="card"><p>Hello</p></div>',
    '<config><server port="8080" /></config>',
    'The package manifest reads {"name": "belay", "version": "2.0.0"}.',
    'Call it with arguments: { "arguments": ["--watch"], "name": "dev" }.',
    "```ts\nfunction name() {\n  return readFile(path);\n}\n```",
  ];
  for (const text of prose) {
    assert.equal(
      classifyProviderProtocolAnomaly({ providerId: "deepseek", text, toolCalls: [] }),
      null,
      text,
    );
  }
});
