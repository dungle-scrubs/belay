import type { Server } from "node:http";
import { nodeMigrationFs, planLegacyMigration } from "@trevor/session/legacy-migration";
import { abbreviateHome } from "@trevor/session/node-paths";
import { type RunningServer, startServer } from "./server";

/**
 * Shared production boot path for Trevor's local stores.
 *
 * Responsible for: env-driven port/host convention, detect-only legacy migration nudge,
 * startServer binding, and the standard listen banner.
 * Not for: constructing domain stores, choosing storage paths, or defining HTTP routes.
 */
export interface StartStoreOptions {
  readonly name: string;
  readonly envPrefix: string;
  readonly reservedPort: number;
  readonly dataLabel: string;
  readonly dataPath: string;
  readonly legacyArtifact?: string;
  readonly legacyLabel?: string;
  readonly legacyOverrideEnv?: string;
  build(): Server;
}

export function startStore(options: StartStoreOptions): Promise<RunningServer> {
  const port = Number(process.env[`${options.envPrefix}_PORT`] ?? options.reservedPort);
  const host = process.env[`${options.envPrefix}_HOST`];
  reportLegacyData(options);
  return startServer(options.build(), {
    port,
    host,
    onListen: (boundPort) => {
      console.log(
        `[${options.name}] listening on http://${host ?? "127.0.0.1"}:${boundPort} ` +
          `(${options.dataLabel}: ${abbreviateHome(options.dataPath)})`,
      );
    },
  });
}

function reportLegacyData(options: StartStoreOptions): void {
  if (!options.legacyArtifact || !options.legacyOverrideEnv) {
    return;
  }
  const legacy = planLegacyMigration(nodeMigrationFs).actions.find(
    (action) => action.artifact === options.legacyArtifact,
  );
  if (legacy?.status !== "migrate") {
    return;
  }
  console.log(
    `[${options.name}] legacy ${options.legacyLabel ?? options.dataLabel} data detected at ` +
      `${abbreviateHome(legacy.source)}; import it via migration or set ${options.legacyOverrideEnv}`,
  );
}
