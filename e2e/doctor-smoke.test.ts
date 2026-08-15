import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DoctorSnapshot,
  decodeDoctorSnapshot,
  type InternetSnapshot,
  overallStatus,
} from "@belay/session";
import { buildDoctorCommandResult, type DoctorCommandInput } from "@host/doctor/build";
import type { ProviderRegistry } from "@host/providers";
import { Effect, Stream } from "effect";
import { afterEach, beforeEach, expect, test } from "vitest";

/**
 * Plan 41 M9: a hermetic end-to-end drive of the REAL `/doctor` snapshot builder - the same
 * `buildDoctorCommandResult` the `/doctor` command runs - across the health scenarios operators hit:
 * a healthy host, a degraded (unreachable cloud) provider, and offline internet. Deterministic (fake
 * providers, an injected internet snapshot, an isolated state home) so it runs in the required
 * no-model / no-network e2e lane. Storage-root and tool-roster severities are pinned by the host unit
 * tests (doctor/snapshot.test.ts); this asserts the end-to-end command → JSON → decoded-snapshot path
 * produces the right overall severity and areas an operator reads.
 */

let stateHome: string;
const savedStateHome = process.env.BELAY_STATE_HOME;

beforeEach(() => {
  stateHome = mkdtempSync(join(tmpdir(), "belay-doctor-e2e-"));
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

const ONLINE: InternetSnapshot = {
  status: "online",
  checking: false,
  checkedAt: "2026-07-05T00:00:00.000Z",
  error: null,
  targetClass: "dns+https",
};

const OFFLINE: InternetSnapshot = {
  ...ONLINE,
  status: "offline",
  error: "HTTPS probe failed",
};

/** A fake provider: only `readiness()` is exercised by /doctor; the rest satisfy the registry shape. */
function fakeProvider(over: {
  readonly label: string;
  readonly model: string;
  readonly kind: "local" | "cloud";
  readonly ready: boolean;
}): ProviderRegistry[string] {
  return {
    id: over.label.toLowerCase(),
    label: over.label,
    model: over.model,
    reasoningLevels: [],
    defaultReasoning: "off",
    kind: over.kind,
    describe: () => ({
      label: over.label,
      model: over.model,
      reasoningLevels: [],
      defaultReasoning: "off",
      kind: over.kind,
    }),
    readiness: () => Effect.succeed({ ready: over.ready, warm: over.ready }),
    capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 8192 }),
    warm: () => Effect.void,
    stream: () => Stream.empty,
  } as unknown as ProviderRegistry[string];
}

function facts(over: {
  readonly providers: ProviderRegistry;
  readonly internet: InternetSnapshot;
}): DoctorCommandInput {
  return {
    providers: over.providers,
    internet: over.internet,
    cwd: "/repo",
    workspace: "/repo",
    instanceId: "e2e-host",
    role: "leader",
    host: { queued: 0, lastTurn: "answered" },
  };
}

async function snapshotFor(input: DoctorCommandInput): Promise<DoctorSnapshot> {
  const json = await buildDoctorCommandResult("", input);
  const snapshot = decodeDoctorSnapshot(json);
  assert.ok(snapshot, "the default /doctor result decodes to a structured snapshot");
  return snapshot;
}

const areaStatus = (snap: DoctorSnapshot, id: string): string | undefined =>
  snap.areas.find((a) => a.id === id)?.status;

test("a reachable provider on an online host reports Providers and Internet ok, nothing in error", async () => {
  const providers = {
    qwen: fakeProvider({ label: "Qwen", model: "qwen3", kind: "local", ready: true }),
  } as unknown as ProviderRegistry;

  // Storage roots probe the REAL filesystem (e.g. an importable legacy ~/.belay can warn), so a
  // hermetic run cannot assert the whole host is ok - only the areas these inputs control.
  const snap = await snapshotFor(facts({ providers, internet: ONLINE }));
  expect(areaStatus(snap, "providers")).toBe("ok");
  expect(areaStatus(snap, "internet")).toBe("ok");
  expect(overallStatus(snap)).not.toBe("error");
});

test("an unreachable cloud provider drives the Providers area - and the whole report - to error", async () => {
  const providers = {
    gpt: fakeProvider({ label: "GPT", model: "gpt-5.5", kind: "cloud", ready: false }),
  } as unknown as ProviderRegistry;

  const snap = await snapshotFor(facts({ providers, internet: ONLINE }));
  expect(areaStatus(snap, "providers")).toBe("error");
  expect(overallStatus(snap)).toBe("error");
  const providersArea = snap.areas.find((a) => a.id === "providers");
  assert.ok(
    providersArea?.findings?.some((f) => f.status === "error"),
    "the unreachable cloud provider is an error finding",
  );
});

test("an unreachable LOCAL runtime is a warning, not an outage, with a start next-action", async () => {
  const providers = {
    qwen: fakeProvider({ label: "Qwen", model: "qwen3", kind: "local", ready: false }),
  } as unknown as ProviderRegistry;

  const snap = await snapshotFor(facts({ providers, internet: ONLINE }));
  expect(areaStatus(snap, "providers")).toBe("warn");
  const finding = snap.areas.find((a) => a.id === "providers")?.findings?.[0];
  assert.ok(finding?.nextAction, "a down local runtime offers a start-the-runtime next action");
});

test("offline internet surfaces as a warning in the Internet area", async () => {
  const providers = {
    qwen: fakeProvider({ label: "Qwen", model: "qwen3", kind: "local", ready: true }),
  } as unknown as ProviderRegistry;

  const snap = await snapshotFor(facts({ providers, internet: OFFLINE }));
  const internet = snap.areas.find((a) => a.id === "internet");
  expect(internet?.status).toBe("warn");
  expect(internet?.verdict).toBe("offline");
});
