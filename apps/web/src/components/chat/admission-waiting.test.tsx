import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { storedLog } from "@trevor/test-kit";
import { test } from "vitest";
import { admissionWaiting } from "@/derive";
import { AdmissionWaitingRow } from "./admission-waiting";

/**
 * The local-model admission waiting row + its derivation (plan 11 M7). Pins that a queued turn shows a
 * bounded "waiting" status with its place in line, that a granted/cleared turn shows nothing, and that
 * the derivation is scoped to the active run.
 */

test("a queued turn renders the waiting row with its place in line", () => {
  const { getByRole, getByText } = render(
    <AdmissionWaitingRow
      waiting={{
        runId: "r",
        provider: "lmstudio",
        model: "qwen3.6-27b-mlx",
        priority: "foreground",
        position: 2,
      }}
    />,
  );
  assert.ok(getByRole("status"), "the live status row renders");
  assert.ok(getByText(/Waiting for qwen3.6-27b-mlx/), "names the model");
  assert.ok(getByText(/#3 in line/), "shows the 1-based place in line");
});

test("a background subagent wait notes its priority; no wait renders nothing", () => {
  const { getByText } = render(
    <AdmissionWaitingRow
      waiting={{
        runId: "c",
        provider: "lmstudio",
        model: "m",
        priority: "background",
        position: 0,
      }}
    />,
  );
  assert.ok(getByText(/\(background\)/), "the background class is noted");

  const empty = render(<AdmissionWaitingRow waiting={null} />);
  assert.equal(empty.container.firstChild, null, "no wait renders nothing");
});

test("admissionWaiting derives a wait for the active run and clears it once granted", () => {
  // A turn is in flight (assistant.started, no completion yet) and queued for the local runtime.
  const queued = storedLog(
    { type: "assistant.started", payload: { runId: "run-1" } },
    {
      type: "admission.status",
      payload: {
        runId: "run-1",
        phase: "queued",
        provider: "lmstudio",
        model: "qwen3.6-27b-mlx",
        priority: "foreground",
        position: 1,
      },
    },
  );
  const waiting = admissionWaiting(queued);
  assert.equal(waiting?.model, "qwen3.6-27b-mlx");
  assert.equal(waiting?.position, 1);

  // Once acquired, the wait clears (a later status for the same run supersedes the queued one).
  const cleared = [
    ...queued,
    ...storedLog({
      type: "admission.status",
      payload: {
        runId: "run-1",
        phase: "acquired",
        provider: "lmstudio",
        model: "qwen3.6-27b-mlx",
        priority: "foreground",
      },
    }),
  ];
  assert.equal(admissionWaiting(cleared), null, "a granted turn no longer waits");

  // With no active run (the admission.status alone, no in-flight assistant.started) there is no wait.
  assert.equal(admissionWaiting([queued[1] as never]), null, "no active run -> no wait");
});
