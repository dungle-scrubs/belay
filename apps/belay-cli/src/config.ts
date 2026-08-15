import { type LoadedBelayConfig, loadBelayConfig } from "@belay/session/node-config";

/**
 * CLI config resolution for model defaults.
 *
 * Responsible for: `flag > env > config.jsonc > host default` model/reasoning precedence.
 * Not for: parsing JSONC or owning provider defaults; `@belay/session/node-config` and the host own those.
 */

export interface ModelConfigInput {
  readonly flagModel?: string;
  readonly flagReasoning?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly loadedConfig?: LoadedBelayConfig;
}

export interface ResolvedModelConfig {
  readonly model?: string;
  readonly reasoning?: string;
  readonly warning: string | null;
}

export function resolveModelConfig(input: ModelConfigInput): ResolvedModelConfig {
  const env = input.env ?? process.env;
  const loadedConfig = input.loadedConfig ?? loadBelayConfig({ env });
  const model = input.flagModel ?? env.TREVOR_MODEL ?? loadedConfig.config.model;
  const reasoning = input.flagReasoning ?? env.TREVOR_REASONING ?? loadedConfig.config.reasoning;
  return {
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
    warning: loadedConfig.warning,
  };
}
