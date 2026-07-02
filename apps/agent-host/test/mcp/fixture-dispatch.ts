import {
  BIG_FIXTURE_CHARS,
  catalogPage,
  catalogToolsFor,
  FIXTURE_ELICITATION_PARAMS,
  FIXTURE_PROMPTS,
  FIXTURE_RESOURCE_CONTENTS,
  FIXTURE_RESOURCES,
  FIXTURE_SAMPLING_PARAMS,
  type FixtureCatalogMode,
  fixturePromptResult,
} from "./fixture-catalog";

/**
 * Shared JSON-RPC dispatch for the MCP fixture servers (test support, plan 23): both fixtures
 * (./fixture-server over stdio frames, ./fixture-http-server over http/SSE/sessions) delegate
 * every wire-agnostic method here - initialize, the paginated catalog lists, prompts/get,
 * resources/read, and the common tools/call behaviors (echo, env_probe, args_probe, big,
 * soft_fail, boom, hang) - plus the pending server-originated-request bookkeeping behind the
 * M6 mediation probes. The fixtures keep ONLY their wire mechanics and wire-specific triggers
 * (crash/crash_loud/garbage framing on stdio; garbage/sever/stream plumbing on http) local.
 * Deliberately independent of src/mcp, so the integration tests stay cross-implementation.
 */

export interface JsonRpcIn {
  readonly jsonrpc?: string;
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: {
    readonly protocolVersion?: string;
    readonly cursor?: string;
    readonly name?: string;
    readonly uri?: string;
    readonly arguments?: Record<string, unknown>;
  };
  readonly result?: unknown;
  readonly error?: unknown;
}

/** What the dispatcher wants sent back; "none" means deliberately no reply (hang, notifications). */
export type FixtureReply =
  | { readonly kind: "result"; readonly id: JsonRpcIn["id"]; readonly value: unknown }
  | {
      readonly kind: "error";
      readonly id: JsonRpcIn["id"];
      readonly code: number;
      readonly message: string;
    }
  | { readonly kind: "none" };

const textResult = (text: string): unknown => ({ content: [{ type: "text", text }] });

export interface FixtureDispatcherOptions {
  /** The serverInfo.name the initialize result advertises (differs per fixture). */
  readonly serverInfoName: string;
  /** Forces the initialize result's protocolVersion; default echoes the client's request. */
  readonly protocolVersion?: string | undefined;
  /** Which shared catalog the list methods serve. */
  readonly catalog: FixtureCatalogMode;
}

export interface FixtureDispatcher {
  readonly dispatch: (message: JsonRpcIn) => FixtureReply;
}

/** Builds the wire-agnostic method dispatcher; one instance per fixture server process/instance
 *  (it owns the tools/list call counter behind the "counting" catalog). */
export function createFixtureDispatcher(options: FixtureDispatcherOptions): FixtureDispatcher {
  let toolsListCalls = 0;

  const result = (id: JsonRpcIn["id"], value: unknown): FixtureReply => ({
    kind: "result",
    id,
    value,
  });

  const error = (id: JsonRpcIn["id"], code: number, message: string): FixtureReply => ({
    kind: "error",
    id,
    code,
    message,
  });

  const toolCall = (message: JsonRpcIn): FixtureReply => {
    const name = message.params?.name;
    const args = message.params?.arguments;
    if (name === "echo") {
      return result(message.id, textResult(String(args?.text ?? "")));
    }
    if (name === "env_probe") {
      return result(message.id, textResult(JSON.stringify(process.env)));
    }
    if (name === "args_probe") {
      return result(message.id, textResult(JSON.stringify(args ?? {})));
    }
    if (name === "big") {
      return result(message.id, textResult("b".repeat(Number(args?.chars ?? BIG_FIXTURE_CHARS))));
    }
    if (name === "soft_fail") {
      return result(message.id, {
        content: [{ type: "text", text: "external service exploded" }],
        isError: true,
      });
    }
    if (name === "boom") {
      return error(message.id, -32001, "boom tool always fails");
    }
    if (name === "hang") {
      return { kind: "none" }; // deliberately never responds
    }
    return error(message.id, -32601, `unknown tool ${String(name)}`);
  };

  return {
    dispatch(message) {
      if (message.method === "initialize") {
        return result(message.id, {
          protocolVersion:
            options.protocolVersion ?? message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: options.serverInfoName, version: "0.0.1" },
        });
      }
      if (message.method === "tools/list") {
        if (message.params?.cursor === undefined) {
          toolsListCalls += 1;
        }
        const { page, nextCursor } = catalogPage(
          catalogToolsFor(options.catalog, toolsListCalls),
          message.params?.cursor,
        );
        return result(message.id, { tools: page, ...(nextCursor ? { nextCursor } : {}) });
      }
      if (message.method === "resources/list") {
        const { page, nextCursor } = catalogPage(FIXTURE_RESOURCES, message.params?.cursor);
        return result(message.id, { resources: page, ...(nextCursor ? { nextCursor } : {}) });
      }
      if (message.method === "prompts/list") {
        const { page, nextCursor } = catalogPage(FIXTURE_PROMPTS, message.params?.cursor);
        return result(message.id, { prompts: page, ...(nextCursor ? { nextCursor } : {}) });
      }
      if (message.method === "prompts/get") {
        const expanded = fixturePromptResult(message.params?.name, message.params?.arguments);
        if (!expanded) {
          return error(message.id, -32602, `unknown prompt ${String(message.params?.name)}`);
        }
        return result(message.id, expanded);
      }
      if (message.method === "resources/read") {
        const uri = message.params?.uri;
        const contents = uri === undefined ? undefined : FIXTURE_RESOURCE_CONTENTS[uri];
        if (!contents) {
          return error(message.id, -32002, `resource not found: ${String(uri)}`);
        }
        return result(message.id, {
          contents: [
            {
              uri,
              mimeType: contents.mimeType,
              ...(contents.text !== undefined ? { text: contents.text } : { blob: contents.blob }),
            },
          ],
        });
      }
      if (message.method === "tools/call") {
        return toolCall(message);
      }
      if (message.id !== undefined) {
        return error(message.id, -32601, `method not found: ${String(message.method)}`);
      }
      return { kind: "none" }; // an unknown notification carries no reply
    },
  };
}

export interface FixtureServerRequests {
  /** Registers a server-originated request and returns its JSON-RPC envelope to put on the
   *  wire; `onResponse` fires when the client's response is settled through {@link settle}. */
  readonly open: (
    method: string,
    params: unknown,
    onResponse: (response: JsonRpcIn) => void,
  ) => Record<string, unknown>;
  /** Routes a client-sent JSON-RPC RESPONSE to its waiting request; false when unknown. */
  readonly settle: (message: JsonRpcIn) => boolean;
}

/** The pending server-originated-request bookkeeping behind the M6 mediation probes. */
export function createFixtureServerRequests(): FixtureServerRequests {
  const pending = new Map<string, (response: JsonRpcIn) => void>();
  let seq = 0;

  return {
    open(method, params, onResponse) {
      seq += 1;
      const id = `srv-${seq}`;
      pending.set(id, onResponse);
      return { jsonrpc: "2.0", id, method, params };
    },
    settle(message) {
      const waiter = message.id === undefined ? undefined : pending.get(String(message.id));
      if (!waiter) {
        return false;
      }
      pending.delete(String(message.id));
      waiter(message);
      return true;
    },
  };
}

/** The server-originated request each mediation probe tool sends (M6). */
export function probeRequest(name: "elicit_probe" | "sampling_probe"): {
  readonly method: string;
  readonly params: unknown;
} {
  return name === "elicit_probe"
    ? { method: "elicitation/create", params: FIXTURE_ELICITATION_PARAMS }
    : { method: "sampling/createMessage", params: FIXTURE_SAMPLING_PARAMS };
}

/** Serializes exactly what the server observed in the client's JSON-RPC response, so the probe
 *  tools can answer the original call with it and tests read what the SERVER saw. */
export function observedResponseText(response: JsonRpcIn): string {
  return JSON.stringify({
    ...(response.result !== undefined ? { result: response.result } : {}),
    ...(response.error !== undefined ? { error: response.error } : {}),
  });
}
