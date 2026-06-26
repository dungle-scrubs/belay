import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The server lifecycle shared by Trevor's local stores: bind a `node:http` server to a
 * loopback port and hand back a uniform handle with its resolved URL/port and a single
 * `close()` teardown. Production binds the configured port (and logs a banner); tests
 * bind port 0 for an ephemeral one. Both go through THIS path, so listen/shutdown is
 * written and reasoned about once - the kit owns no routes or domain knowledge.
 */

/** A running server bound to a loopback port, with its resolved URL and a single teardown. */
export interface RunningServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface StartServerOptions {
  /** The port to bind. Use 0 for an ephemeral port (tests); the resolved port is on the handle. */
  readonly port: number;
  /** The interface to bind. Defaults to loopback (127.0.0.1). */
  readonly host?: string;
  /** Invoked once the socket is listening, with the resolved port (e.g. to log a banner). */
  readonly onListen?: (port: number) => void;
}

/**
 * Binds `server` and resolves once it is listening, with a handle whose `url`/`port`
 * reflect the actually-bound port (so an ephemeral `port: 0` is usable). `close()`
 * resolves when the server has stopped accepting connections; it rejects on a close error.
 */
export function startServer(server: Server, opts: StartServerOptions): Promise<RunningServer> {
  const host = opts.host ?? "127.0.0.1";

  return new Promise((resolve) => {
    server.listen(opts.port, host, () => {
      const port = (server.address() as AddressInfo).port;
      opts.onListen?.(port);
      resolve({
        url: `http://${host}:${port}`,
        port,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
