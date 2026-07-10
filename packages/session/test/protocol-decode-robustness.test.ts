import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEvent } from "../src/event";
import { decodeTrevorEvent } from "../src/protocol/decode";
import { DECODE_SEEDS } from "./decode-seeds";

/**
 * The protocol decode robustness net. During the wire-table migration this file ran a full
 * differential against a frozen copy of the hand-written decoders (see the migration branch
 * history) proving byte-identical output; the frozen copy is retired, and what remains is the
 * permanent contract the corpus pins:
 *  - decoding is TOTAL: every seed payload plus systematic mutations (dropped keys, nulls,
 *    wrong-typed values, junk, empties, unknown keys, one level deep too) decodes without
 *    throwing - malformed wire input degrades, it never breaks replay;
 *  - every registered wire type decodes its own realistic payloads non-null, tagged with its
 *    own type;
 *  - the seed corpus itself stays honest against the registered wire-type list, so a new
 *    event kind must bring seeds here.
 */

const JUNK_VALUES: readonly unknown[] = [null, "junk", 42, true, [], {}, ""];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Systematic mutations of one payload: the seed itself, {}, and per-key drops/replacements,
 *  recursing one level into object-valued keys (usage, breakdown, stop, diagnostic, ...). */
function mutations(seed: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [seed, {}, { ...seed, __unknown: "extra" }];
  for (const key of Object.keys(seed)) {
    const dropped = { ...seed };
    delete dropped[key];
    out.push(dropped);
    for (const junk of JUNK_VALUES) {
      out.push({ ...seed, [key]: junk });
    }
    const value = seed[key];
    if (isPlainRecord(value)) {
      for (const innerKey of Object.keys(value)) {
        const innerDropped = { ...value };
        delete innerDropped[innerKey];
        out.push({ ...seed, [key]: innerDropped });
        for (const junk of JUNK_VALUES) {
          out.push({ ...seed, [key]: { ...value, [innerKey]: junk } });
        }
      }
    }
  }
  return out;
}

function envelope(type: string, payload: Record<string, unknown>): SessionEvent {
  return {
    createdAt: "2026-01-02T03:04:05.000Z",
    eventId: "evt_differential_1",
    payload,
    producerId: "host",
    seq: 7,
    sessionId: "ses_differential",
    type,
  };
}

for (const seed of DECODE_SEEDS) {
  test(`decode is total and self-tagged: ${seed.type}`, () => {
    for (const variant of seed.variants) {
      // The realistic (unmutated) payload decodes non-null and carries its own type tag.
      const clean = decodeTrevorEvent(envelope(seed.type, variant));
      assert.ok(clean !== null, `realistic payload decoded to null: ${JSON.stringify(variant)}`);
      assert.equal(clean.type, seed.type);
      // Every mutation still decodes without throwing (null is acceptable, a throw is not).
      for (const payload of mutations(variant)) {
        decodeTrevorEvent(envelope(seed.type, payload));
      }
    }
  });
}

test("the decode corpus covers every registered wire type", () => {
  // A wire type the registry knows but the corpus never feeds is silent non-coverage: the
  // decoder could regress there without this suite noticing. Seeds must track the registry.
  const seeded = new Set(DECODE_SEEDS.map((seed) => seed.type));
  const missing: string[] = [];
  for (const type of REGISTERED_WIRE_TYPES) {
    if (!seeded.has(type)) {
      missing.push(type);
    }
  }
  assert.deepStrictEqual(missing, [], "registered wire types missing from DECODE_SEEDS");
});

/** Every wire name the decoder dispatches on (the wireEvent table names); the coverage
 *  test above keeps DECODE_SEEDS honest against it. */
const REGISTERED_WIRE_TYPES: readonly string[] = [
  "admission.status",
  "assistant.completed",
  "assistant.continued",
  "assistant.delta",
  "assistant.limit",
  "assistant.overflow",
  "assistant.progress",
  "assistant.reconnecting",
  "assistant.recovered",
  "assistant.started",
  "assistant.thinking",
  "command.result",
  "context.compacted",
  "context.compacting",
  "delegated.to",
  "editor.open",
  "file.index.requested",
  "file.index.result",
  "folder.pick.requested",
  "folder.pick.result",
  "handoff.accepted",
  "handoff.approved",
  "handoff.failed",
  "handoff.generated",
  "handoff.generating",
  "handoff.rejected",
  "handoff.requested",
  "hook.decision",
  "host.beat",
  "host.hello",
  "host.internet",
  "host.online",
  "host.role",
  "host.sourceAuth",
  "loop.status",
  "lucid.feedback",
  "lucid.published",
  "lucid.review",
  "model.switch.requested",
  "model.switched",
  "project.add.requested",
  "project.add.result",
  "project.collapse.requested",
  "project.collapse.result",
  "project.remove.requested",
  "project.remove.result",
  "project.rename.requested",
  "project.rename.result",
  "projects.list.requested",
  "projects.list.result",
  "provider.question.answer",
  "provider.question.requested",
  "provider.question.resolved",
  "session.archived",
  "session.deleted",
  "session.forkedFrom",
  "session.launch.requested",
  "session.launch.result",
  "session.project",
  "session.switch",
  "session.tangentOf",
  "session.title",
  "session.worktree",
  "shell.result",
  "tangent.created",
  "tangent.foldedBack",
  "tasks.current",
  "tool.completed",
  "tool.guardrail",
  "tool.started",
  "user.cancel",
  "user.command",
  "user.message",
  "user.shell",
  "user.supersede",
  "workflow.agent",
  "workflow.completed",
  "workflow.leaf-failed",
  "workflow.log",
  "workflow.phase",
  "workflow.started",
];
