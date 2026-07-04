import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

/**
 * Plan 29 M8 (classifier consumption gate) + M7 (producers stay opt-in). The corpus is diagnostic-only
 * in this plan: it is recorded and inspected, but never read back into a model prompt, the history
 * projection, or a runtime classifier rule (D-003). These structural tests fence that boundary - a new
 * importer or a wired-up later producer fails the gate until a future plan explicitly authorizes the
 * consumption path.
 */

// This file lives at apps/agent-host/src/providers/<this>; the repo root is five levels up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The corpus modules any observation import must resolve to. */
const CORPUS_MODULES = /observation-(store|corpus|envelope|inspect)/;

/**
 * The ONLY runtime modules allowed to import the observation corpus: the corpus modules themselves, the
 * single provider-failure producer, and the doctor/debug read surface. Anything else - especially a
 * prompt builder, the history projection, or the failure classifier - importing the corpus is a
 * consumption-boundary breach.
 */
const ALLOWED_IMPORTERS = new Set([
  join("apps", "agent-host", "src", "providers", "observation-store.ts"),
  join("apps", "agent-host", "src", "providers", "observation-corpus.ts"),
  join("apps", "agent-host", "src", "providers", "observation-envelope.ts"),
  join("apps", "agent-host", "src", "providers", "observation-inspect.ts"),
  join("apps", "agent-host", "src", "agent", "loop-failures.ts"),
  join("apps", "agent-host", "src", "doctor", "build.ts"),
]);

/** The later-producer envelope builders that must stay unwired (schema-only) until a plan authorizes them. */
const UNWIRED_PRODUCERS = /\b(toolPatternEnvelope|loopPatternEnvelope|harnessGuidanceEnvelope)\b/;

function collectRuntimeSources(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRuntimeSources(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
}

function allRuntimeSources(): string[] {
  const files: string[] = [];
  for (const root of ["apps", "packages"]) {
    collectRuntimeSources(join(REPO_ROOT, root), files);
  }
  return files;
}

test("the observation corpus is imported only by its producer and doctor/debug read surface (M8 non-consumption)", () => {
  const offenders = allRuntimeSources()
    .map((file) => relative(REPO_ROOT, file))
    .filter((rel) => !ALLOWED_IMPORTERS.has(rel))
    .filter((rel) => {
      const text = readFileSync(join(REPO_ROOT, rel), "utf8");
      // Match only import statements that pull from a corpus module.
      return text
        .split("\n")
        .some((line) => /\bfrom\b/.test(line) && CORPUS_MODULES.test(line) && /import/.test(line));
    });

  assert.deepEqual(
    offenders,
    [],
    `observation corpus imported outside the allowed producer/reader surface (a prompt, history, or classifier consumer?): ${offenders.join(", ")}`,
  );
});

test("no runtime module wires the later-producer envelope builders (M7 opt-in)", () => {
  const envelopeModule = join("apps", "agent-host", "src", "providers", "observation-envelope.ts");
  const offenders = allRuntimeSources()
    .map((file) => relative(REPO_ROOT, file))
    .filter((rel) => rel !== envelopeModule) // the builders are DEFINED here
    .filter((rel) => UNWIRED_PRODUCERS.test(readFileSync(join(REPO_ROOT, rel), "utf8")));

  assert.deepEqual(
    offenders,
    [],
    `a later-producer envelope builder is wired to a runtime path before a plan authorized it: ${offenders.join(", ")}`,
  );
});

test("the failure classifier does not read observation data at runtime (M8 no rule mutation)", () => {
  const classifier = readFileSync(
    join(REPO_ROOT, "apps", "agent-host", "src", "providers", "failure-taxonomy.ts"),
    "utf8",
  );
  assert.ok(
    !CORPUS_MODULES.test(classifier),
    "the classifier must not import the observation corpus - its rules stay static, not learned at runtime",
  );
});
