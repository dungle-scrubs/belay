/** Model load state for a provider: reachable, and warm (loaded) vs cold. */
export interface Readiness {
  readonly ready: boolean;
  readonly warm: boolean;
}

/**
 * A model provider the host streams completions from. Readiness is per-adapter:
 * local providers report real load state; cloud providers are always warm.
 */
export interface Provider {
  readonly id: string;
  readonly model: string;
  /** Whether the provider is reachable and the model is loaded (warm) vs cold. */
  readiness(): Promise<Readiness>;
  /** Loads a cold local model; a no-op when already warm or cloud-hosted. */
  warm(): Promise<void>;
  /** Streams text chunks for one completion. */
  stream(prompt: string): AsyncIterable<string>;
}
