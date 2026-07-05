import { test } from "vitest";
import { type SessionTransport, streamTransport } from "../src/index";
import { runTransportConformance } from "./transport-conformance";

/**
 * The SAME transport conformance suite, run against a live Tether service. Tether is the durable,
 * multi-instance backend; proving it passes the identical contract is what lets the host and web
 * treat the local session-store and Tether interchangeably (D-009). Tether speaks the same
 * `/sessions` REST + WS contract, so it is just a `streamTransport` pointed at TETHER_URL - there is
 * no separate adapter. This is the gated live lane: with no TETHER_URL it skips with a stated reason
 * rather than failing.
 */

const url = process.env.TETHER_URL;

if (!url) {
  test.skip("tether transport conformance (set TETHER_URL to run)", () => {});
} else {
  const transport: SessionTransport = streamTransport(url);
  runTransportConformance({ transport: () => transport });
}
