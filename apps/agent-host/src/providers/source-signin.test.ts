import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrevorEventInput } from "@trevor/session";
import { test, vi } from "vitest";
import type { LoginCallbacks } from "./provider-auth";
import { makeSourceSignIn } from "./source-signin";

/**
 * The /source-signin flow's one-at-a-time state machine. Driven through a FAKE login (the targetFor
 * seam) whose callbacks the test holds, so the phases and the supersede/cancel gating are pinned
 * hermetically: `starting` fires the instant the command lands (the real login takes seconds to mint
 * its URL - the silent gap read as a dead Re-authenticate button); a superseded flow's zombie
 * emissions are dropped (a real login can't always be aborted, and its late device-code/cancelled
 * events flapped the chooser); an explicit cancel emits its own `cancelled` (the flow's catch may
 * never run). A completing flow writes to an injected temp store, never the real ~/.pi/auth.json.
 */

interface FakeFlow {
  readonly cb: LoginCallbacks;
  readonly finish: (credentials: Record<string, unknown>) => void;
  readonly fail: (error: Error) => void;
}

function harness() {
  const emitted: TrevorEventInput[] = [];
  const flows: FakeFlow[] = [];
  let refreshes = 0;
  const authPathPromise = mkdtemp(join(tmpdir(), "trevor-signin-")).then(async (dir) => {
    const path = join(dir, "auth.json");
    await writeFile(path, JSON.stringify({ other: { key: "keep-me" } }), "utf8");
    return path;
  });

  const build = async () => {
    const authPath = await authPathPromise;
    const signIn = makeSourceSignIn({
      emit: (event) => {
        emitted.push(event);
        return Promise.resolve();
      },
      refreshCatalog: () => {
        refreshes += 1;
      },
      authPath,
      targetFor: (sourceId) =>
        sourceId === "anthropic"
          ? {
              oauthName: "anthropic",
              login: (cb) =>
                new Promise<Record<string, unknown>>((resolve, reject) => {
                  flows.push({ cb, finish: resolve, fail: reject });
                }),
            }
          : null,
    });
    return { signIn, authPath };
  };

  const phases = () =>
    emitted.filter((e) => e.type === "host.sourceAuth").map((e) => e.payload.phase as string);

  return { build, emitted, flows, phases, refreshes: () => refreshes };
}

/** Lets the flow's fire-and-forget promise chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test("start emits `starting` immediately, then the flow's device-code URL when it arrives", async () => {
  const h = harness();
  const { signIn } = await h.build();
  signIn.startSourceSignIn("anthropic");
  assert.deepEqual(h.phases(), ["starting"], "instant feedback, before the login mints anything");

  h.flows[0]?.cb.onAuthUrl({ url: "https://claude.ai/oauth/authorize?x=1" });
  assert.deepEqual(h.phases(), ["starting", "device-code"]);
  const dc = h.emitted.at(-1);
  assert.equal(dc?.payload.verificationUri, "https://claude.ai/oauth/authorize?x=1");
  assert.equal(dc?.payload.acceptsCode, true, "the browser+paste flow accepts a pasted code");
});

test("an unknown source errors without starting a flow", async () => {
  const h = harness();
  const { signIn } = await h.build();
  signIn.startSourceSignIn("nope");
  assert.deepEqual(h.phases(), ["error"]);
  assert.equal(h.flows.length, 0);
});

test("a new start SUPERSEDES the in-flight flow: the zombie's late events are dropped", async () => {
  const h = harness();
  const { signIn } = await h.build();
  signIn.startSourceSignIn("anthropic"); // flow 0
  signIn.startSourceSignIn("anthropic"); // flow 1 supersedes
  assert.deepEqual(h.phases(), ["starting", "starting"]);

  // The zombie can't be stopped (the real login ignores the abort signal) - its late URL and its
  // eventual unwind must NOT overwrite the live flow's state.
  h.flows[0]?.cb.onAuthUrl({ url: "https://zombie.example/auth" });
  h.flows[0]?.fail(new Error("aborted"));
  await settle();
  assert.deepEqual(h.phases(), ["starting", "starting"], "zombie emissions dropped");

  // The LIVE flow's URL still lands.
  h.flows[1]?.cb.onAuthUrl({ url: "https://claude.ai/oauth/authorize?live=1" });
  assert.equal(
    h.emitted.at(-1)?.payload.verificationUri,
    "https://claude.ai/oauth/authorize?live=1",
  );
});

test("cancel emits `cancelled` itself and silences the aborted flow's own unwind", async () => {
  const h = harness();
  const { signIn } = await h.build();
  signIn.startSourceSignIn("anthropic");
  signIn.cancelSignIn();
  assert.deepEqual(h.phases(), ["starting", "cancelled"], "the cancel is visible immediately");

  // The aborted flow unwinds later; its own cancelled must not double-emit.
  h.flows[0]?.fail(new Error("aborted"));
  await settle();
  assert.deepEqual(h.phases(), ["starting", "cancelled"]);

  // Cancel with nothing in flight is a no-op.
  signIn.cancelSignIn();
  assert.deepEqual(h.phases(), ["starting", "cancelled"]);
});

test("a zombie's late requestCode rejects instead of clobbering the live flow's resolver", async () => {
  const h = harness();
  const { signIn } = await h.build();
  signIn.startSourceSignIn("anthropic"); // flow 0
  signIn.startSourceSignIn("anthropic"); // flow 1 live

  // The zombie registers late: it must reject, not become the resolver /source-signin-code feeds.
  await assert.rejects(h.flows[0]?.cb.requestCode() as Promise<string>);

  // The live flow registers, and the pasted code resolves IT.
  const liveCode = h.flows[1]?.cb.requestCode() as Promise<string>;
  signIn.submitSignInCode("provider-code-42");
  assert.equal(await liveCode, "provider-code-42");
});

test("a completed flow persists the credential to the injected store and refreshes the catalog", async () => {
  const h = harness();
  const { signIn, authPath } = await h.build();
  signIn.startSourceSignIn("anthropic");
  h.flows[0]?.cb.onAuthUrl({ url: "https://claude.ai/oauth/authorize?x=1" });
  h.flows[0]?.finish({ type: "oauth", refresh: "r1", access: "a1", expires: 9999 });
  // The completion crosses real file I/O (the credential write) before its emit; wait for it.
  await vi.waitUntil(() => h.phases().includes("complete"));

  assert.deepEqual(h.phases(), ["starting", "device-code", "complete"]);
  assert.equal(h.refreshes(), 1, "a fresh credential re-projects the catalog");
  const stored = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(stored.anthropic, { type: "oauth", refresh: "r1", access: "a1", expires: 9999 });
  assert.deepEqual(stored.other, { key: "keep-me" }, "other entries preserved");
});
