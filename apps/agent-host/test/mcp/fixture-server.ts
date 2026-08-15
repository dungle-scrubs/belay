import { pumpStdinFrames, send, sendRaw } from "../support/stdio-frames";
import type { FixtureCatalogMode } from "./fixture-catalog";
import {
  createFixtureDispatcher,
  createFixtureServerRequests,
  type JsonRpcIn,
  observedResponseText,
  probeRequest,
} from "./fixture-dispatch";

/**
 * A minimal MCP stdio fixture server for the transport integration tests (plan 23 M2/M4/M5).
 * Speaks JSON-RPC 2.0 over LSP-style Content-Length frames through the shared fixture frame
 * pump (../support/stdio-frames - deliberately independent of src/mcp/framing.ts, so the tests
 * are cross-implementation, not self-confirming). Method dispatch - initialize, the paginated
 * ./fixture-catalog lists, prompts/get, resources/read, and the common tools/call behaviors
 * (echo, env_probe, args_probe, big, soft_fail, boom, hang) - is the shared
 * ./fixture-dispatch; only the wire mechanics and stdio-specific triggers live here:
 *   crash      - exits the process without responding
 *   crash_loud - writes the server env secret to stderr, then exits (C5 scrub tests)
 *   garbage    - responds with a well-framed but non-JSON body
 * M6 mediation probes (elicit_probe / sampling_probe) send a server-originated REQUEST mid
 * tools/call and answer the original call with the client's JSON-RPC response as JSON text.
 * Flags: `--protocol=<v>` forces the initialize result's protocolVersion (negotiation tests);
 * `--catalog=large|counting` selects a ./fixture-catalog mode; `--init=hang` never answers
 * initialize (handshake-timeout tests). Exits 0 when stdin ends.
 */

const protocolOverride = process.argv
  .find((arg) => arg.startsWith("--protocol="))
  ?.slice("--protocol=".length);

const catalogMode = (process.argv
  .find((arg) => arg.startsWith("--catalog="))
  ?.slice("--catalog=".length) ?? "default") as FixtureCatalogMode;

const initMode = process.argv.find((arg) => arg.startsWith("--init="))?.slice("--init=".length);

const dispatcher = createFixtureDispatcher({
  serverInfoName: "belay-mcp-fixture",
  protocolVersion: protocolOverride,
  catalog: catalogMode,
});

const serverRequests = createFixtureServerRequests();

pumpStdinFrames((body) => handle(JSON.parse(body) as JsonRpcIn));

function handle(message: JsonRpcIn): void {
  if (message.method === undefined) {
    // A JSON-RPC RESPONSE to one of our server-originated requests (M6 probes).
    serverRequests.settle(message);
    return;
  }
  if (message.method === "initialize" && initMode === "hang") {
    return; // deliberately never answers the handshake (C1 handshake-timeout tests)
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (name === "crash") {
      process.exit(7);
    }
    if (name === "crash_loud") {
      // C5: leak the explicit server env to stderr, then die - the transport must scrub it.
      process.stderr.write(
        `fatal: secret=${process.env.MCP_FIXTURE_SECRET ?? "unset"} exploded\n`,
        () => setTimeout(() => process.exit(9), 50),
      );
      return;
    }
    if (name === "garbage") {
      sendRaw("this is not json {");
      return;
    }
    if (name === "elicit_probe" || name === "sampling_probe") {
      const callId = message.id;
      const { method, params } = probeRequest(name);
      send(
        serverRequests.open(method, params, (response) => {
          send({
            jsonrpc: "2.0",
            id: callId,
            result: { content: [{ type: "text", text: observedResponseText(response) }] },
          });
        }),
      );
      return;
    }
  }
  const reply = dispatcher.dispatch(message);
  if (reply.kind === "result") {
    send({ jsonrpc: "2.0", id: reply.id, result: reply.value });
  } else if (reply.kind === "error") {
    send({ jsonrpc: "2.0", id: reply.id, error: { code: reply.code, message: reply.message } });
  }
  // "none": deliberately no reply (hang, notifications).
}
