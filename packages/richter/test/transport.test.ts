import type { SessionTransport } from "@trevor/session";
import { runTransportConformance } from "@trevor/session/conformance";
import { test } from "vitest";
import { richterTransport } from "../src/index";

/**
 * The SAME transport conformance suite, run against a live Richter service. Richter is the
 * durable, multi-instance backend; proving it passes the identical contract is what lets
 * the host and web treat local session-store and Richter interchangeably (D-009). This is
 * the gated live lane: with no RICHTER_URL it skips with a stated reason rather than failing.
 */

const url = process.env.RICHTER_URL;

if (!url) {
  test.skip("richter transport conformance (set RICHTER_URL to run)", () => {});
} else {
  const transport: SessionTransport = richterTransport(url);
  runTransportConformance({ transport: () => transport });
}
