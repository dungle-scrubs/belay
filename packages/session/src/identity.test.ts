import assert from "node:assert/strict";
import { test } from "vitest";
import {
  clipProducerId,
  controlProducerId,
  freshSessionId,
  hostIdentity,
  isAnswerableProducer,
  isClipProducer,
  isControlProducer,
  isSelfProducer,
  projectSessionId,
  recallProducerId,
  shortHash,
  viewerIdentity,
} from "./identity";

/**
 * The project launcher (D-085) derives a session id from the project root. These pin the two
 * properties the launcher leans on: the id is STABLE for a given root (reopen → same session) and
 * URL-safe (no slash/space/other character that would break a `?session=<id>` URL or storage key),
 * and DISTINCT across roots that happen to share a basename.
 */

test("projectSessionId is stable for a given root", () => {
  const a = projectSessionId("/Users/kevin/dev/belay");
  const b = projectSessionId("/Users/kevin/dev/belay");
  assert.equal(a, b);
});

test("projectSessionId is URL-safe: only lowercase alphanumerics and dashes, no slashes", () => {
  const id = projectSessionId("/Users/kevin/dev/My Project (v2)!");
  assert.match(id, /^[a-z0-9-]+$/);
  assert.equal(id.includes("/"), false);
  // basename slug + 8-hex hash.
  assert.match(id, /^my-project-v2-[0-9a-f]{8}$/);
});

test("two roots sharing a basename get distinct ids (hash separates them)", () => {
  const a = projectSessionId("/Users/kevin/dev/app/web");
  const b = projectSessionId("/Users/kevin/work/app/web");
  assert.notEqual(a, b);
  assert.ok(a.startsWith("web-"));
  assert.ok(b.startsWith("web-"));
});

test("a root that slugifies to nothing falls back to a usable id", () => {
  const id = projectSessionId("/____");
  assert.match(id, /^project-[0-9a-f]{8}$/);
});

test("shortHash is 8 hex chars and deterministic", () => {
  assert.match(shortHash("abc"), /^[0-9a-f]{8}$/);
  assert.equal(shortHash("abc"), shortHash("abc"));
  assert.notEqual(shortHash("abc"), shortHash("abd"));
});

test("freshSessionId is timestamped, URL-safe, and entropy-distinct", () => {
  const now = new Date("2026-06-26T12:34:56.789Z");
  const a = freshSessionId({ now, random: "one" });
  const b = freshSessionId({ now, random: "two" });

  assert.match(a, /^belay-20260626-123456z-[0-9a-f]{8}$/);
  assert.equal(a, freshSessionId({ now, random: "one" }));
  assert.notEqual(a, b);
});

test("freshSessionId sanitizes custom prefixes", () => {
  const id = freshSessionId({
    prefix: "My Project!",
    now: new Date("2026-06-26T12:34:56.000Z"),
    random: "entropy",
  });
  assert.match(id, /^my-project-20260626-123456z-[0-9a-f]{8}$/);
});

test("hostIdentity stamps the canonical host runtime kind", () => {
  assert.deepEqual(hostIdentity({ instanceId: "host-1", participantId: "p1" }), {
    displayName: "belay-host",
    runtimeKind: "belay",
    instanceId: "host-1",
    participantId: "p1",
    capabilities: undefined,
  });
});

test("viewerIdentity stamps the canonical non-host runtime kind", () => {
  assert.deepEqual(viewerIdentity({ displayName: "launcher", instanceId: "v1" }), {
    displayName: "launcher",
    runtimeKind: "web",
    instanceId: "v1",
    participantId: "v1",
    capabilities: undefined,
  });
});

test("producer channel helpers derive host-owned sub-producers", () => {
  assert.equal(controlProducerId("host"), "host:control");
  assert.equal(clipProducerId("host"), "host:clip");
  assert.equal(recallProducerId("host"), "host:recall");
});

test("producer provenance predicates keep control lanes answerable", () => {
  assert.equal(isSelfProducer("host", "host"), true);
  assert.equal(isSelfProducer("host:control", "host"), false);
  assert.equal(isAnswerableProducer("host", "host"), false);
  assert.equal(isAnswerableProducer("host:control", "host"), true);
  assert.equal(isAnswerableProducer("web", "host"), true);
});

test("producer provenance predicates recognize named host lanes", () => {
  assert.equal(isControlProducer("host:control", "host"), true);
  assert.equal(isControlProducer("host:clip", "host"), false);
  assert.equal(isClipProducer("host:clip", "host"), true);
  assert.equal(isClipProducer("host", "host"), false);
});
