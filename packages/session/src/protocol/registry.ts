import type { SessionEvent } from "../event";
import type { DecodedEvent } from "./decode";

export interface EventFamily {
  readonly decode: (event: SessionEvent) => DecodedEvent | null;
  readonly notes?: string;
  readonly wireNames: readonly string[];
}

export interface ProtocolRegistry {
  readonly decode: (event: SessionEvent) => DecodedEvent | null;
  readonly familyFor: (wireName: string) => EventFamily | undefined;
  readonly wireNames: () => readonly string[];
}

/**
 * Owns Trevor event-family registration and lookup. Family modules can register the wire names they
 * decode without exposing registry internals through the package root.
 */
export function createProtocolRegistry(families: readonly EventFamily[]): ProtocolRegistry {
  const byWireName = new Map<string, EventFamily>();
  for (const family of families) {
    for (const wireName of family.wireNames) {
      if (byWireName.has(wireName)) {
        throw new Error(`Duplicate Trevor protocol event registration: ${wireName}`);
      }
      byWireName.set(wireName, family);
    }
  }

  return {
    decode: (event) => byWireName.get(event.type)?.decode(event) ?? null,
    familyFor: (wireName) => byWireName.get(wireName),
    wireNames: () => [...byWireName.keys()].sort(),
  };
}
