/**
 * The host-owned registry of local models THIS Trevor instance loaded (plan 11.1 M2).
 *
 * LM Studio keeps every loaded model resident, and Trevor loads a local model on demand
 * (`ensureMaxContext` -> `lms load`) but only ever unloads the SAME model to resize it - so models
 * accumulate and contend for unified memory / GPU. Bounding that footprint safely requires knowing which
 * models TREVOR loaded, because eviction must NEVER unload a model loaded outside Trevor (a manually-
 * loaded model, another app's model). This registry is that authority: `isTrevorLoaded` gates eviction
 * eligibility (D-004), and `resident()` is the per-instance view /doctor renders and the eviction sweep
 * consults.
 *
 * It is a SEPARATE host-owned component, not `LmStudioClient` internal state, so the sweep (M4) and the
 * doctor surface (M6) read one host-level view rather than reaching into each client. The client only
 * RECORDS loads/unloads here (via {@link ResidencyRecorder}); the cross-INSTANCE claim + eviction logic
 * lives above it (M3-M5) on plan 11's shared store.
 *
 * Responsible for: tracking which local models THIS instance loaded (eviction eligibility).
 * Not for: cross-instance claims or unloading - claims.ts and eviction.ts own those.
 */

/** One local model this instance loaded: the provider + endpoint it lives on, its id, and the context it
 *  loaded at. `provider` is carried so residency claim keys can be rebuilt without a hardcoded id. */
export interface ResidentModel {
  readonly provider: string;
  /** The LM Studio endpoint (base URL) the model is resident on. */
  readonly endpoint: string;
  readonly model: string;
  /** The context window (tokens) the model was loaded at (its KV-cache footprint driver). */
  readonly contextLength: number;
  /** ISO time this instance recorded the load. */
  readonly loadedAt: string;
}

/** The write surface the LM Studio client uses to record its own loads/unloads into the registry, so
 *  the client depends only on this narrow contract, not the whole registry. */
export interface ResidencyRecorder {
  recordLoad(provider: string, endpoint: string, model: string, contextLength: number): void;
  recordUnload(endpoint: string, model: string): void;
}

/** The composite key for a resident model: a model id is only unique WITHIN an endpoint. */
function residentKey(endpoint: string, model: string): string {
  return `${endpoint} ${model}`;
}

export class LocalResidencyRegistry implements ResidencyRecorder {
  private readonly loaded = new Map<string, ResidentModel>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Records (or refreshes) that this instance loaded `model` on `endpoint` at `contextLength`. */
  recordLoad(provider: string, endpoint: string, model: string, contextLength: number): void {
    this.loaded.set(residentKey(endpoint, model), {
      provider,
      endpoint,
      model,
      contextLength,
      loadedAt: new Date(this.now()).toISOString(),
    });
  }

  /** Records that this instance unloaded `model` on `endpoint` (it is no longer Trevor-resident). */
  recordUnload(endpoint: string, model: string): void {
    this.loaded.delete(residentKey(endpoint, model));
  }

  /** Whether THIS instance loaded `model` on `endpoint` (eviction eligibility - D-004). */
  isTrevorLoaded(endpoint: string, model: string): boolean {
    return this.loaded.has(residentKey(endpoint, model));
  }

  /** The models this instance currently has resident, newest-first, for /doctor + the eviction sweep. */
  resident(): readonly ResidentModel[] {
    return [...this.loaded.values()].sort((a, b) => b.loadedAt.localeCompare(a.loadedAt));
  }
}
