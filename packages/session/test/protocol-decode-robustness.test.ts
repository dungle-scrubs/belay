import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEvent } from "../src/event";
import { decodeTrevorEvent, REGISTERED_WIRE_TYPES } from "../src/protocol/decode";
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
    if (Array.isArray(value)) {
      for (const junk of JUNK_VALUES) {
        out.push({ ...seed, [key]: [junk] });
        out.push({ ...seed, [key]: [...value, junk] });
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
      // Every mutation of a REGISTERED type still decodes non-null and self-tagged: the
      // table decode is total, so malformed known events degrade to safe values - they
      // never throw and never silently drop to null.
      for (const payload of mutations(variant)) {
        const decoded = decodeTrevorEvent(envelope(seed.type, payload));
        assert.ok(decoded !== null, `mutation decoded to null: ${JSON.stringify(payload)}`);
        assert.equal(decoded.type, seed.type);
      }
    }
  });
}

test("the decode corpus matches the registered wire types exactly", () => {
  // A wire type the registry knows but the corpus never feeds is silent non-coverage; a
  // seed for an unregistered type is dead weight; a duplicate seed hides a lost variant.
  // The registered list is DERIVED from the decode tables, so this cannot drift.
  const seedTypes = DECODE_SEEDS.map((seed) => seed.type);
  assert.equal(new Set(seedTypes).size, seedTypes.length, "duplicate seed types");
  assert.deepStrictEqual([...seedTypes].sort(), [...REGISTERED_WIRE_TYPES]);
});
